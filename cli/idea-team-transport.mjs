const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENV_KEYS = ["CHORUS_TURN_UUID", "CHORUS_ADMISSION_UUID", "CHORUS_IDEA_TEAM_TURNS"];

export function ideaTeamHeaders(proof) {
  if (!proof) return {};
  const { turnUuid, admissionUuid, supplementaryTurns } = proof;
  if (!UUID.test(turnUuid ?? "") || !UUID.test(admissionUuid ?? "")) throw new Error("Invalid Idea Team turn/admission UUID pair");
  const headers = { "X-Chorus-Turn-Uuid": turnUuid, "X-Chorus-Admission-Uuid": admissionUuid };
  if (supplementaryTurns !== undefined) {
    const encoded = JSON.stringify(supplementaryTurns);
    if (!Array.isArray(supplementaryTurns) || supplementaryTurns.length > 16 || Buffer.byteLength(encoded) > 4096 ||
        supplementaryTurns.some((pair) => !pair || Object.keys(pair).sort().join(",") !== "admissionUuid,turnUuid" ||
          !UUID.test(pair.turnUuid ?? "") || !UUID.test(pair.admissionUuid ?? ""))) throw new Error("Invalid supplementary Idea Team proofs");
    headers["X-Chorus-Idea-Team-Turns"] = encoded;
  }
  return headers;
}

export function ideaTeamProofFromEnv(env) {
  if (!ENV_KEYS.some((key) => env[key] !== undefined)) return undefined;
  const proof = {
    turnUuid: env.CHORUS_TURN_UUID, admissionUuid: env.CHORUS_ADMISSION_UUID,
    ...(env.CHORUS_IDEA_TEAM_TURNS !== undefined ? { supplementaryTurns: JSON.parse(env.CHORUS_IDEA_TEAM_TURNS) } : {}),
  };
  ideaTeamHeaders(proof);
  return proof;
}

export function ideaTeamRunEnv(env, proof) {
  const result = { ...env };
  for (const key of Object.keys(result)) if (ENV_KEYS.includes(key.toUpperCase())) delete result[key];
  const headers = ideaTeamHeaders(proof);
  if (proof) {
    result.CHORUS_TURN_UUID = proof.turnUuid;
    result.CHORUS_ADMISSION_UUID = proof.admissionUuid;
    if (headers["X-Chorus-Idea-Team-Turns"]) result.CHORUS_IDEA_TEAM_TURNS = headers["X-Chorus-Idea-Team-Turns"];
  }
  return result;
}

export function validIdeaTeamContext(context) {
  const validFence = (fence) => fence && [fence.ideaUuid, fence.ownerUuid, fence.agentUuid].every((value) => typeof value === "string" && UUID.test(value)) &&
    Number.isSafeInteger(fence.generation) && fence.generation >= 0 && ["orchestrator", "product"].includes(fence.role);
  if (context?.ideaTeam !== undefined && !validFence(context.ideaTeam)) return false;
  if (context?.ideaTeams !== undefined && (!Array.isArray(context.ideaTeams) || !context.ideaTeams.length ||
      !context.ideaTeams.every(validFence) || !context.ideaTeam || !context.ideaTeams.some((fence) =>
        ["ideaUuid", "ownerUuid", "agentUuid", "generation", "role"].every((key) => fence[key] === context.ideaTeam[key])))) return false;
  return true;
}
