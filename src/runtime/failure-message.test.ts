import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFailureReply, runtimeFailureRetryAfterMs } from "./failure-message.js";

test("runtime failure messaging distinguishes exhausted plan usage", () => {
  assert.equal(
    runtimeFailureReply({
      code: "subscription_sharing_usage_limit_exceeded",
      status: 429,
      message: "A ChatGPT sharing limit has been reached.",
    }),
    "ChatGPT 额度暂时用完，请在额度恢复后重试。",
  );
});

test("runtime failure messaging keeps ordinary 429 distinct from plan exhaustion", () => {
  assert.equal(
    runtimeFailureReply({ code: "api_error", status: 429, message: "Too many requests." }),
    "ChatGPT 请求受到限流，请稍后重试。",
  );
});

test("runtime failure messaging identifies expired ChatGPT login", () => {
  assert.equal(
    runtimeFailureReply({ code: "refresh_token_expired", message: "expired" }),
    "ChatGPT 登录已失效，请重新登录后继续。",
  );
});


test("transient model transport failures request an inbound retry", () => {
  assert.equal(
    runtimeFailureRetryAfterMs(new Error("Responses WebSocket closed before response.completed.")),
    5_000,
  );
});

test("runtime retry safety hint blocks replay after possible side effects", () => {
  const error = new Error("Responses WebSocket closed before response.completed.") as Error & {
    inboundRetryable?: boolean;
  };
  error.inboundRetryable = false;
  assert.equal(runtimeFailureRetryAfterMs(error), undefined);
});

test("plan exhaustion is reported but not automatically replayed", () => {
  assert.equal(
    runtimeFailureRetryAfterMs({
      code: "subscription_sharing_usage_limit_exceeded",
      status: 429,
      message: "A ChatGPT sharing limit has been reached.",
    }),
    undefined,
  );
  assert.equal(runtimeFailureRetryAfterMs(Object.assign(
    new Error("A ChatGPT sharing limit has been reached"),
    { code: "subscription_sharing_usage_limit_exceeded", status: 429, inboundRetryable: true },
  )), undefined, "a safe manual replay hint must not schedule an automatic retry");
});

test("generic SIWC processing error with request ID is automatically retryable", () => {
  const error = new Error(
    "An error occurred while processing your request. You can retry your request. Please include the request ID req_example.",
  );
  assert.equal(runtimeFailureRetryAfterMs(error), 5_000);
  (error as Error & { inboundRetryable?: boolean }).inboundRetryable = false;
  assert.equal(runtimeFailureRetryAfterMs(error), undefined, "a possible write must still block automatic replay");
});

test("stale previous response IDs are treated as recoverable, without hiding unrelated errors", () => {
  assert.equal(runtimeFailureRetryAfterMs({
    code: "invalid_request_error",
    status: 400,
    message: "Previous response with id 'resp_example' not found.",
  }), 5_000);
  assert.equal(runtimeFailureRetryAfterMs({
    code: "invalid_request_error", status: 400, message: "Malformed request.",
  }), undefined);
});
