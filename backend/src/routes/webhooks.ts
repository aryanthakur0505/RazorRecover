import { Router } from "express";
import { prisma } from "../db";
import { verifyWebhookSignature } from "../services/razorpay";
import { razorpayWebhookSchema } from "../schemas/webhook";
import { classifyFailure } from "../services/classification";
import { processFailedPayment } from "../services/recoveryOrchestrator";
import { resolveLiveOutcome } from "../services/executionService";
import { writeAudit } from "../services/auditService";
import { asyncHandler } from "../middleware/errorHandler";

export const webhooksRouter = Router();

/**
 * Razorpay → Webhook → Signature Verification → Idempotency → Recovery Workflow.
 * This route is mounted with an `express.raw()` body parser (see server.ts) so we can verify
 * the HMAC signature over the exact bytes Razorpay sent, before any JSON parsing happens.
 * An unverified webhook is NEVER processed.
 */
webhooksRouter.post(
  "/razorpay",
  asyncHandler(async (req, res) => {
    const rawBody = (req.body as Buffer).toString("utf8");
    const signature = req.header("x-razorpay-signature");

    if (!verifyWebhookSignature(rawBody, signature)) {
      res.status(400).json({ error: "Invalid webhook signature" });
      return;
    }

    const json = JSON.parse(rawBody);
    const parsed = razorpayWebhookSchema.safeParse(json);
    if (!parsed.success) {
      // Signature was valid but shape was unexpected — ack with 200 so Razorpay doesn't retry
      // forever on a payload we simply don't model, but log it for visibility.
      console.warn("[webhook] unrecognized payload shape:", parsed.error.flatten());
      res.status(200).json({ received: true, note: "unrecognized payload shape" });
      return;
    }

    const event = parsed.data;
    const paymentEntity = event.payload.payment?.entity;
    const orderEntity = event.payload.order?.entity;

    // Idempotency key: Razorpay's own event id isn't consistently present in every payload
    // shape, so we derive a stable one from event + entity id + timestamp — a redelivered
    // webhook for the same event always produces the same key.
    const razorpayEventId = `${event.event}:${paymentEntity?.id ?? orderEntity?.id ?? "unknown"}:${event.created_at ?? 0}`;

    const existing = await prisma.webhookEvent.findUnique({ where: { razorpayEventId } });
    if (existing) {
      res.status(200).json({ received: true, duplicate: true });
      return;
    }

    await prisma.webhookEvent.create({
      data: { razorpayEventId, eventType: event.event, payload: json },
    });

    const merchant = await prisma.merchant.findFirst();
    if (!merchant) {
      res.status(200).json({ received: true, note: "no merchant provisioned yet" });
      return;
    }

    if (event.event === "payment.failed" && paymentEntity) {
      const customerEmail = paymentEntity.email ?? `unknown+${paymentEntity.id}@example.test`;
      const customer =
        (await prisma.customer.findFirst({ where: { merchantId: merchant.id, email: customerEmail } })) ??
        (await prisma.customer.create({
          data: {
            merchantId: merchant.id,
            name: paymentEntity.contact ?? "Unknown customer",
            email: customerEmail,
          },
        }));

      const classification = classifyFailure({
        errorCode: paymentEntity.error_code,
        errorDescription: paymentEntity.error_description,
        errorReason: paymentEntity.error_reason,
        amount: paymentEntity.amount,
        method: paymentEntity.method,
        eventType: "payment.failed",
      });

      let payment = await prisma.payment.findFirst({ where: { razorpayPaymentId: paymentEntity.id } });
      if (!payment) {
        payment = await prisma.payment.create({
          data: {
            merchantId: merchant.id,
            customerId: customer.id,
            razorpayPaymentId: paymentEntity.id,
            razorpayOrderId: paymentEntity.order_id ?? undefined,
            amount: paymentEntity.amount,
            currency: paymentEntity.currency,
            status: "FAILED",
            failureCategory: classification.category,
            failureReasonRaw: paymentEntity.error_description ?? paymentEntity.error_reason ?? undefined,
            isSuspicious: classification.isSuspicious,
            failedAt: new Date(),
          },
        });
      }

      await writeAudit({
        merchantId: merchant.id,
        paymentId: payment.id,
        customerId: customer.id,
        eventType: "WEBHOOK_RECEIVED",
        failureReason: classification.rationale,
        amount: payment.amount,
        idempotencyKey: razorpayEventId,
      });

      // Acknowledge Razorpay immediately rather than blocking the response on the full recovery
      // pipeline (classify → score → decide → guardrail → execute is several sequential DB round
      // trips). Razorpay's webhook delivery has its own timeout and will retry a slow response as
      // a duplicate delivery — safe either way thanks to the idempotency ledger above, but there's
      // no reason to risk it, or to make Razorpay (and a burst of concurrent failures) wait on
      // work that doesn't affect whether this webhook was received and recorded.
      res.status(200).json({ received: true });
      processFailedPayment(payment.id).catch((err) => {
        console.error(`[webhook] recovery pipeline failed for payment ${payment.id}:`, err);
      });
      return;
    }

    if ((event.event === "order.paid" || event.event === "payment.captured") && (orderEntity || paymentEntity)) {
      const payment = await prisma.payment.findFirst({
        where: {
          OR: [
            orderEntity ? { razorpayOrderId: orderEntity.id } : undefined,
            paymentEntity ? { razorpayPaymentId: paymentEntity.id } : undefined,
          ].filter(Boolean) as any,
        },
      });
      res.status(200).json({ received: true });
      if (payment) {
        resolveLiveOutcome(payment.id, true).catch((err) => {
          console.error(`[webhook] outcome resolution failed for payment ${payment.id}:`, err);
        });
      }
      return;
    }

    res.status(200).json({ received: true, note: "event type not handled" });
  }),
);
