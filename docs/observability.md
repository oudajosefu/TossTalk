# Observability (Internal Only)

No end-user-facing diagnostics are required.

Log events for engineering:

- Gate transitions (`UnmutedLive`, `AirborneSuppressed`, `ImpactLockout`, `Reacquire`)
- Reconnect/recovery attempts and durations
- Battery level trend and low-battery transitions
- BLE packet counters (sent/dropped)

Keep retention short and avoid storing identifiable session data.