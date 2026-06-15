// cli/upload-hooks.mjs
// Reserved upload-hook points for the future observability layer (derived idea
// "Daemon 连接可观测与管理"). This change ships them as no-op async stubs so the
// observability work can report connection / session / transcript data to the
// server WITHOUT touching the wake path. This change itself uploads NOTHING.
//
// cli-daemon spec "Reserved upload hooks for observability".

/**
 * @typedef {Object} UploadHooks
 * @property {(info: { host: string, agentUuid?: string }) => Promise<void>} onConnect
 * @property {(info: { rootIdeaKey: string, sessionId: string, isNew: boolean }) => Promise<void>} onSessionStart
 * @property {(info: { rootIdeaKey: string, sessionId: string, message: any }) => Promise<void>} onTranscriptMessage
 */

/**
 * The default no-op hooks. Each resolves immediately and does nothing — no
 * network, no disk. The observability idea will provide a real implementation
 * with the same shape and the daemon will accept it via dependency injection.
 * @returns {UploadHooks}
 */
export function createNoopUploadHooks() {
  return {
    async onConnect() {},
    async onSessionStart() {},
    async onTranscriptMessage() {},
  };
}
