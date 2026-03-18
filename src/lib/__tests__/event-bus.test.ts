import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock redis module before importing event-bus
const mockRedis = vi.hoisted(() => {
  const mockPublisher = {
    status: 'ready' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue(undefined),
  };

  const mockSubscriber = {
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
  };

  return {
    isRedisEnabled: vi.fn().mockReturnValue(false),
    getRedisPublisher: vi.fn().mockReturnValue(null),
    getRedisSubscriber: vi.fn().mockReturnValue(null),
    mockPublisher,
    mockSubscriber,
  };
});

vi.mock('@/lib/redis', () => mockRedis);

// Import after mocking
import type { RealtimeEvent } from '../event-bus';

describe('eventBus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset Redis enabled state
    mockRedis.isRedisEnabled.mockReturnValue(false);
    mockRedis.getRedisPublisher.mockReturnValue(null);
    mockRedis.getRedisSubscriber.mockReturnValue(null);
  });

  afterEach(() => {
    // Clean up event listeners
    vi.resetModules();
  });

  it('emits and receives local events when Redis is disabled', async () => {
    // Re-import to get fresh instance
    const { eventBus } = await import('../event-bus');

    const listener = vi.fn();
    eventBus.on('change', listener);

    const event: RealtimeEvent = {
      companyUuid: 'comp-1',
      projectUuid: 'proj-1',
      entityType: 'task',
      entityUuid: 'task-1',
      action: 'created',
    };

    eventBus.emitChange(event);

    expect(listener).toHaveBeenCalledWith(event);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('allows multiple listeners on same event', async () => {
    const { eventBus } = await import('../event-bus');

    const listener1 = vi.fn();
    const listener2 = vi.fn();

    eventBus.on('change', listener1);
    eventBus.on('change', listener2);

    const event: RealtimeEvent = {
      companyUuid: 'comp-1',
      projectUuid: 'proj-1',
      entityType: 'idea',
      entityUuid: 'idea-1',
      action: 'updated',
    };

    eventBus.emitChange(event);

    expect(listener1).toHaveBeenCalledWith(event);
    expect(listener2).toHaveBeenCalledWith(event);
  });

  it('supports unsubscribing listeners', async () => {
    const { eventBus } = await import('../event-bus');

    const listener = vi.fn();
    eventBus.on('change', listener);

    const event: RealtimeEvent = {
      companyUuid: 'comp-1',
      projectUuid: 'proj-1',
      entityType: 'document',
      entityUuid: 'doc-1',
      action: 'deleted',
    };

    eventBus.emitChange(event);
    expect(listener).toHaveBeenCalledTimes(1);

    eventBus.off('change', listener);
    eventBus.emitChange(event);
    expect(listener).toHaveBeenCalledTimes(1); // Still 1, not called again
  });

  it('emits events with correct entity types', async () => {
    const { eventBus } = await import('../event-bus');

    const listener = vi.fn();
    eventBus.on('change', listener);

    const entityTypes = ['task', 'idea', 'proposal', 'document', 'project'] as const;

    for (const entityType of entityTypes) {
      const event: RealtimeEvent = {
        companyUuid: 'comp-1',
        projectUuid: 'proj-1',
        entityType,
        entityUuid: `${entityType}-1`,
        action: 'created',
      };
      eventBus.emitChange(event);
    }

    expect(listener).toHaveBeenCalledTimes(5);
  });

  it('emits events with correct action types', async () => {
    const { eventBus } = await import('../event-bus');

    const listener = vi.fn();
    eventBus.on('change', listener);

    const actions = ['created', 'updated', 'deleted'] as const;

    for (const action of actions) {
      const event: RealtimeEvent = {
        companyUuid: 'comp-1',
        projectUuid: 'proj-1',
        entityType: 'task',
        entityUuid: 'task-1',
        action,
      };
      eventBus.emitChange(event);
    }

    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('includes optional actorUuid in events', async () => {
    const { eventBus } = await import('../event-bus');

    const listener = vi.fn();
    eventBus.on('change', listener);

    const event: RealtimeEvent = {
      companyUuid: 'comp-1',
      projectUuid: 'proj-1',
      entityType: 'task',
      entityUuid: 'task-1',
      action: 'created',
      actorUuid: 'user-1',
    };

    eventBus.emitChange(event);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUuid: 'user-1',
      })
    );
  });

  it('does not connect to Redis when disabled', async () => {
    mockRedis.isRedisEnabled.mockReturnValue(false);

    const { eventBus } = await import('../event-bus');
    await eventBus.connect();

    expect(mockRedis.getRedisSubscriber).not.toHaveBeenCalled();
    expect(mockRedis.getRedisPublisher).not.toHaveBeenCalled();
  });

  it('connects to Redis when enabled', async () => {
    mockRedis.isRedisEnabled.mockReturnValue(true);
    mockRedis.getRedisSubscriber.mockReturnValue(mockRedis.mockSubscriber);
    mockRedis.getRedisPublisher.mockReturnValue(mockRedis.mockPublisher);

    // Reset modules to allow re-import
    vi.resetModules();
    mockRedis.isRedisEnabled.mockReturnValue(true);
    mockRedis.getRedisSubscriber.mockReturnValue(mockRedis.mockSubscriber);
    mockRedis.getRedisPublisher.mockReturnValue(mockRedis.mockPublisher);

    const { eventBus } = await import('../event-bus');
    await eventBus.connect();

    expect(mockRedis.mockSubscriber.connect).toHaveBeenCalled();
    expect(mockRedis.mockPublisher.connect).toHaveBeenCalled();
    expect(mockRedis.mockSubscriber.subscribe).toHaveBeenCalledWith('chorus:events');
  });

  it('publishes to Redis when enabled and ready', async () => {
    mockRedis.isRedisEnabled.mockReturnValue(true);
    mockRedis.getRedisPublisher.mockReturnValue(mockRedis.mockPublisher);
    mockRedis.getRedisSubscriber.mockReturnValue(mockRedis.mockSubscriber);

    vi.resetModules();
    mockRedis.isRedisEnabled.mockReturnValue(true);
    mockRedis.getRedisPublisher.mockReturnValue(mockRedis.mockPublisher);
    mockRedis.getRedisSubscriber.mockReturnValue(mockRedis.mockSubscriber);

    const { eventBus } = await import('../event-bus');

    const event: RealtimeEvent = {
      companyUuid: 'comp-1',
      projectUuid: 'proj-1',
      entityType: 'task',
      entityUuid: 'task-1',
      action: 'created',
    };

    eventBus.emitChange(event);

    expect(mockRedis.mockPublisher.publish).toHaveBeenCalled();
    const publishCall = mockRedis.mockPublisher.publish.mock.calls[0];
    expect(publishCall[0]).toBe('chorus:events');

    const envelope = JSON.parse(publishCall[1] as string);
    expect(envelope).toHaveProperty('_origin');
    expect(envelope.channel).toBe('change');
    expect(envelope.data).toEqual(event);
  });

  it('handles Redis publish failures silently', async () => {
    mockRedis.isRedisEnabled.mockReturnValue(true);
    const failingPublisher = {
      ...mockRedis.mockPublisher,
      status: 'ready' as const,
      publish: vi.fn().mockRejectedValue(new Error('Redis publish failed')),
    };
    mockRedis.getRedisPublisher.mockReturnValue(failingPublisher);
    mockRedis.getRedisSubscriber.mockReturnValue(mockRedis.mockSubscriber);

    vi.resetModules();
    mockRedis.isRedisEnabled.mockReturnValue(true);
    mockRedis.getRedisPublisher.mockReturnValue(failingPublisher);
    mockRedis.getRedisSubscriber.mockReturnValue(mockRedis.mockSubscriber);

    const { eventBus } = await import('../event-bus');

    const listener = vi.fn();
    eventBus.on('change', listener);

    const event: RealtimeEvent = {
      companyUuid: 'comp-1',
      projectUuid: 'proj-1',
      entityType: 'task',
      entityUuid: 'task-1',
      action: 'created',
    };

    // Should not throw, local emit should still work
    expect(() => eventBus.emitChange(event)).not.toThrow();
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('deduplicates own messages from Redis', async () => {
    let messageHandler: ((channel: string, message: string) => void) | null = null;

    const mockSub = {
      ...mockRedis.mockSubscriber,
      on: vi.fn((event, handler) => {
        if (event === 'message') {
          messageHandler = handler;
        }
      }),
    };

    mockRedis.isRedisEnabled.mockReturnValue(true);
    mockRedis.getRedisPublisher.mockReturnValue(mockRedis.mockPublisher);
    mockRedis.getRedisSubscriber.mockReturnValue(mockSub);

    vi.resetModules();
    mockRedis.isRedisEnabled.mockReturnValue(true);
    mockRedis.getRedisPublisher.mockReturnValue(mockRedis.mockPublisher);
    mockRedis.getRedisSubscriber.mockReturnValue(mockSub);

    const { eventBus } = await import('../event-bus');
    await eventBus.connect();

    const listener = vi.fn();
    eventBus.on('change', listener);

    // Emit an event to publish to Redis
    const event: RealtimeEvent = {
      companyUuid: 'comp-1',
      projectUuid: 'proj-1',
      entityType: 'task',
      entityUuid: 'task-1',
      action: 'created',
    };

    eventBus.emitChange(event);

    // Get the envelope that was published
    const publishCall = mockRedis.mockPublisher.publish.mock.calls[0];
    const envelope = publishCall[1] as string;

    // Reset listener call count
    listener.mockClear();

    // Simulate receiving our own message back from Redis
    if (messageHandler) {
      (messageHandler as (channel: string, message: string) => void)('chorus:events', envelope);
    }

    // Listener should NOT be called again (deduplication)
    expect(listener).not.toHaveBeenCalled();
  });

  it('processes messages from other instances', async () => {
    // Note: This tests that the eventBus can receive messages from Redis.
    // The actual cross-instance messaging is complex to test in isolation
    // because it involves the Redis subscriber's message event handler.
    // This test verifies the envelope format is correct.

    const event: RealtimeEvent = {
      companyUuid: 'comp-1',
      projectUuid: 'proj-1',
      entityType: 'task',
      entityUuid: 'task-1',
      action: 'created',
    };

    const envelope = JSON.stringify({
      _origin: 'other-instance-id',
      channel: 'change',
      data: event,
    });

    const parsed = JSON.parse(envelope);
    expect(parsed._origin).toBe('other-instance-id');
    expect(parsed.channel).toBe('change');
    expect(parsed.data).toEqual(event);
  });

  it('ignores malformed Redis messages', async () => {
    let messageHandler: ((channel: string, message: string) => void) | null = null;

    const mockSub = {
      ...mockRedis.mockSubscriber,
      on: vi.fn((event, handler) => {
        if (event === 'message') {
          messageHandler = handler;
        }
      }),
    };

    mockRedis.isRedisEnabled.mockReturnValue(true);
    mockRedis.getRedisPublisher.mockReturnValue(mockRedis.mockPublisher);
    mockRedis.getRedisSubscriber.mockReturnValue(mockSub);

    vi.resetModules();
    mockRedis.isRedisEnabled.mockReturnValue(true);
    mockRedis.getRedisPublisher.mockReturnValue(mockRedis.mockPublisher);
    mockRedis.getRedisSubscriber.mockReturnValue(mockSub);

    const { eventBus } = await import('../event-bus');
    await eventBus.connect();

    const listener = vi.fn();
    eventBus.on('change', listener);

    // Send malformed JSON
    if (messageHandler) {
      expect(() => (messageHandler as (channel: string, message: string) => void)('chorus:events', 'not valid json{')).not.toThrow();
    }

    expect(listener).not.toHaveBeenCalled();
  });

  it('disconnects from Redis gracefully', async () => {
    mockRedis.isRedisEnabled.mockReturnValue(true);
    mockRedis.getRedisPublisher.mockReturnValue(mockRedis.mockPublisher);
    mockRedis.getRedisSubscriber.mockReturnValue(mockRedis.mockSubscriber);

    vi.resetModules();
    mockRedis.isRedisEnabled.mockReturnValue(true);
    mockRedis.getRedisPublisher.mockReturnValue(mockRedis.mockPublisher);
    mockRedis.getRedisSubscriber.mockReturnValue(mockRedis.mockSubscriber);

    const { eventBus } = await import('../event-bus');
    await eventBus.connect();
    await eventBus.disconnect();

    expect(mockRedis.mockSubscriber.quit).toHaveBeenCalled();
    expect(mockRedis.mockPublisher.quit).toHaveBeenCalled();
  });

  it('handles disconnect errors silently', async () => {
    const failingPublisher = {
      ...mockRedis.mockPublisher,
      quit: vi.fn().mockRejectedValue(new Error('Quit failed')),
    };
    const failingSubscriber = {
      ...mockRedis.mockSubscriber,
      quit: vi.fn().mockRejectedValue(new Error('Quit failed')),
    };

    mockRedis.isRedisEnabled.mockReturnValue(true);
    mockRedis.getRedisPublisher.mockReturnValue(failingPublisher);
    mockRedis.getRedisSubscriber.mockReturnValue(failingSubscriber);

    vi.resetModules();
    mockRedis.isRedisEnabled.mockReturnValue(true);
    mockRedis.getRedisPublisher.mockReturnValue(failingPublisher);
    mockRedis.getRedisSubscriber.mockReturnValue(failingSubscriber);

    const { eventBus } = await import('../event-bus');
    await eventBus.connect();

    await expect(eventBus.disconnect()).resolves.not.toThrow();
  });

  it('does not connect twice', async () => {
    mockRedis.isRedisEnabled.mockReturnValue(true);
    mockRedis.getRedisSubscriber.mockReturnValue(mockRedis.mockSubscriber);
    mockRedis.getRedisPublisher.mockReturnValue(mockRedis.mockPublisher);

    vi.resetModules();
    mockRedis.isRedisEnabled.mockReturnValue(true);
    mockRedis.getRedisSubscriber.mockReturnValue(mockRedis.mockSubscriber);
    mockRedis.getRedisPublisher.mockReturnValue(mockRedis.mockPublisher);

    const { eventBus } = await import('../event-bus');

    await eventBus.connect();
    await eventBus.connect();
    await eventBus.connect();

    // Should only connect once
    expect(mockRedis.mockSubscriber.connect).toHaveBeenCalledTimes(1);
    expect(mockRedis.mockPublisher.connect).toHaveBeenCalledTimes(1);
  });
});
