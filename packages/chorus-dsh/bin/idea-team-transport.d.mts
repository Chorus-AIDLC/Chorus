export interface IdeaTeamTurn { turnUuid: string; admissionUuid: string; supplementaryTurns?: Array<{turnUuid: string; admissionUuid: string}>; }
export function ideaTeamHeaders(proof?: IdeaTeamTurn): Record<string, string>;
export function ideaTeamProofFromEnv(env: Record<string, string | undefined>): IdeaTeamTurn | undefined;
export function ideaTeamRunEnv(env: Record<string, string | undefined>, proof?: IdeaTeamTurn): Record<string, string | undefined>;
export function validIdeaTeamContext(context: unknown): boolean;
