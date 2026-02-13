import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireThreadStatus, _resetAllManagers } from "./thread-status.js";

describe("ThreadStatusManager", () => {
  afterEach(() => {
    vi.useRealTimers();
    _resetAllManagers();
  });

  it("single handle lifecycle: acquire → setStatus → release → grace → push empty → destroy", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      pushIntervalMs: 100,
      graceMs: 5_000,
    });

    // setStatus starts the push loop with an immediate push.
    handle.setStatus("is thinking...");
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("is thinking...");

    // Push loop continues.
    push.mockClear();
    await vi.advanceTimersByTimeAsync(100);
    expect(push).toHaveBeenCalledWith("is thinking...");

    // Release → grace period starts, pushes graceText.
    push.mockClear();
    handle.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(push).toHaveBeenCalledWith("is thinking...");

    // After grace period → pushes empty string.
    push.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(push).toHaveBeenCalledWith("");

    // Loop stopped — no more pushes.
    push.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(push).not.toHaveBeenCalled();
  });

  it("multiple handles — blink-free: h1 release → h2 acquire within grace → no gap", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const h1 = acquireThreadStatus({
      key: "C1:T1",
      push,
      pushIntervalMs: 100,
      graceMs: 5_000,
    });

    h1.setStatus("is thinking...");
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("is thinking...");

    // Release h1 → grace starts.
    h1.release();
    await vi.advanceTimersByTimeAsync(100);

    // Acquire h2 within grace period — grace cancelled.
    push.mockClear();
    const h2 = acquireThreadStatus({
      key: "C1:T1",
      push,
      pushIntervalMs: 100,
      graceMs: 5_000,
    });
    h2.setStatus("is thinking...");

    // Push loop continues seamlessly — no empty push.
    await vi.advanceTimersByTimeAsync(100);
    expect(push).toHaveBeenCalledWith("is thinking...");
    expect(push).not.toHaveBeenCalledWith("");

    // Release h2 → grace again.
    h2.release();
    push.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(push).toHaveBeenCalledWith("");
  });

  it("lazy start: acquire → release without setStatus → no push loop created", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      pushIntervalMs: 100,
      graceMs: 5_000,
    });

    // Release without ever calling setStatus.
    handle.release();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(push).not.toHaveBeenCalled();
  });

  it("idempotent release: double release → no error", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      pushIntervalMs: 100,
      graceMs: 5_000,
    });

    handle.setStatus("is thinking...");
    await vi.advanceTimersByTimeAsync(0);

    handle.release();
    handle.release(); // Second release — should be a no-op.
    await vi.advanceTimersByTimeAsync(5_000);

    // Should still work normally — single grace period → empty push.
    expect(push).toHaveBeenCalledWith("");
  });

  it("in-flight guard: slow push → tick skipped", async () => {
    vi.useFakeTimers();
    let resolveSlowPush: () => void;
    const slowPush = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSlowPush = resolve;
        }),
    );

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push: slowPush,
      pushIntervalMs: 100,
      graceMs: 5_000,
    });

    handle.setStatus("is thinking...");
    // First push starts but doesn't resolve.
    await vi.advanceTimersByTimeAsync(0);
    expect(slowPush).toHaveBeenCalledTimes(1);

    // Next tick — push still in-flight, tick should be skipped.
    await vi.advanceTimersByTimeAsync(100);
    expect(slowPush).toHaveBeenCalledTimes(1);

    // Resolve the first push.
    resolveSlowPush!();
    await vi.advanceTimersByTimeAsync(0);

    // Next tick — push is free, should fire.
    await vi.advanceTimersByTimeAsync(100);
    expect(slowPush).toHaveBeenCalledTimes(2);

    handle.release();
    await vi.advanceTimersByTimeAsync(5_100);
  });

  it("grace text: after release, pushes graceText during grace period", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      pushIntervalMs: 100,
      graceMs: 5_000,
      graceText: "hold on...",
    });

    handle.setStatus("is typing...");
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("is typing...");

    // Release → grace period: should push graceText.
    push.mockClear();
    handle.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(push).toHaveBeenCalledWith("hold on...");

    // After grace → push empty.
    push.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(push).toHaveBeenCalledWith("");
  });

  it("self-cleanup: after destroy, new acquire creates a fresh manager", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const h1 = acquireThreadStatus({
      key: "C1:T1",
      push,
      pushIntervalMs: 100,
      graceMs: 100,
    });

    h1.setStatus("is thinking...");
    await vi.advanceTimersByTimeAsync(0);
    h1.release();

    // Wait for grace + destroy.
    await vi.advanceTimersByTimeAsync(200);
    push.mockClear();

    // New acquire should work with a fresh manager.
    const h2 = acquireThreadStatus({
      key: "C1:T1",
      push,
      pushIntervalMs: 100,
      graceMs: 100,
    });

    h2.setStatus("is typing...");
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("is typing...");

    h2.release();
    await vi.advanceTimersByTimeAsync(200);
  });

  it("setStatus after release is a no-op", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      pushIntervalMs: 100,
      graceMs: 100,
    });

    handle.setStatus("is thinking...");
    await vi.advanceTimersByTimeAsync(0);
    handle.release();

    push.mockClear();
    // setStatus on a released handle should do nothing.
    handle.setStatus("is typing...");
    await vi.advanceTimersByTimeAsync(100);

    // Should push graceText, not "is typing...".
    expect(push).toHaveBeenCalledWith("is thinking...");
    expect(push).not.toHaveBeenCalledWith("is typing...");

    await vi.advanceTimersByTimeAsync(200);
  });

  it("shouldGrace false: skips grace period and clears immediately", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      pushIntervalMs: 100,
      graceMs: 5_000,
      shouldGrace: () => false,
    });

    handle.setStatus("is thinking...");
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("is thinking...");

    // Release with shouldGrace=false → no grace, immediate clear.
    push.mockClear();
    handle.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("");

    // No further pushes — loop stopped.
    push.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(push).not.toHaveBeenCalled();
  });

  it("shouldGrace true: uses normal grace period", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      pushIntervalMs: 100,
      graceMs: 5_000,
      shouldGrace: () => true,
    });

    handle.setStatus("is thinking...");
    await vi.advanceTimersByTimeAsync(0);

    // Release with shouldGrace=true → normal grace period.
    push.mockClear();
    handle.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(push).toHaveBeenCalledWith("is thinking...");
    expect(push).not.toHaveBeenCalledWith("");

    // After grace period → clear.
    push.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(push).toHaveBeenCalledWith("");
  });

  it("shouldGrace dynamic: grace when pending, no grace when empty", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);
    let hasPending = true;

    const h1 = acquireThreadStatus({
      key: "C1:T1",
      push,
      pushIntervalMs: 100,
      graceMs: 5_000,
      shouldGrace: () => hasPending,
    });

    h1.setStatus("is thinking...");
    await vi.advanceTimersByTimeAsync(0);

    // Release h1 with hasPending=true → grace starts.
    h1.release();
    await vi.advanceTimersByTimeAsync(100);

    // h2 acquires within grace → grace cancelled.
    const h2 = acquireThreadStatus({
      key: "C1:T1",
      push,
      pushIntervalMs: 100,
      graceMs: 5_000,
      shouldGrace: () => hasPending,
    });
    h2.setStatus("is typing...");
    await vi.advanceTimersByTimeAsync(100);

    // Now no more pending messages.
    hasPending = false;
    push.mockClear();
    h2.release();
    // shouldGrace returns false → immediate clear.
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("");

    // No more pushes.
    push.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(push).not.toHaveBeenCalled();
  });

  it("push errors are forwarded to onError", async () => {
    vi.useFakeTimers();
    const pushError = new Error("API failure");
    const push = vi.fn().mockRejectedValue(pushError);
    const onError = vi.fn();

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      pushIntervalMs: 100,
      graceMs: 100,
      onError,
    });

    handle.setStatus("is thinking...");
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledWith(pushError);

    handle.release();
    await vi.advanceTimersByTimeAsync(200);
  });
});
