import { afterEach, describe, expect, it, vi } from 'vitest'
import { createExpiryScheduler } from '../../src/modules/bookings/booking-holds.js'
import { memoryLogger, type LoggedLine } from '../helpers.js'

describe('createExpiryScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces concurrent sweeps and throttles read-triggered ones', async () => {
    let release: (value: number) => void = () => {}
    const run = vi.fn(async () => 0).mockImplementationOnce(() => new Promise<number>((resolve) => { release = resolve }))
    const scheduler = createExpiryScheduler({ run, logger: memoryLogger(), minReadIntervalMs: 60_000 })
    const reads = [scheduler.onRead(), scheduler.onRead(), scheduler.sweep()]
    expect(run).toHaveBeenCalledTimes(1)
    release(2)
    await Promise.all(reads)
    await scheduler.onRead() // within the throttle window: no new sweep
    expect(run).toHaveBeenCalledTimes(1)
    await scheduler.sweep() // an explicit sweep is never throttled
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('never throws on a read path; failures are logged without detail and retried next time', async () => {
    const lines: LoggedLine[] = []
    const run = vi.fn().mockRejectedValueOnce(new Error('connection refused')).mockResolvedValue(0)
    const scheduler = createExpiryScheduler({ run, logger: memoryLogger(lines), minReadIntervalMs: 0 })
    await expect(scheduler.onRead()).resolves.toBeUndefined()
    expect(lines.some((line) => line.level === 'warn' && line.message.includes('expiry sweep failed'))).toBe(true)
    await scheduler.onRead()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('runs on an unref’d interval between start() and stop()', async () => {
    vi.useFakeTimers()
    const run = vi.fn(async () => 0)
    const scheduler = createExpiryScheduler({ run, logger: memoryLogger(), intervalMs: 1_000 })
    scheduler.start()
    scheduler.start() // idempotent
    await vi.advanceTimersByTimeAsync(3_000)
    expect(run).toHaveBeenCalledTimes(3)
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).toHaveBeenCalledTimes(3)
  })
})
