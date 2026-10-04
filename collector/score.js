'use strict';

function scoreCandidate(candidate, nowMs) {
  const groups = new Map();
  for (const claim of candidate.sourceClaims.filter((row) => row.status !== 'RETRACTED')) { if (!groups.has(claim.sourceGroup)) groups.set(claim.sourceGroup, []); groups.get(claim.sourceGroup).push(claim.trust); }
  const groupTrust = [...groups.values()].map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
  const trust = groupTrust.length ? groupTrust.reduce((sum, value) => sum + value, 0) / groupTrust.length : 0;
  const ageDays = Math.max(0, (nowMs - Date.parse(candidate.lastSeenAt || 0)) / 86_400_000);
  const freshness = Math.max(0, Math.round(100 * Math.exp(-ageDays / 30)));
  const corroboration = Math.min(30, Math.max(0, groups.size - 1) * 15);
  const conflictsPenalty = Math.min(40, candidate.conflicts.length * 10);
  const confidence = Math.max(0, Math.min(100, Math.round(trust * 55 + freshness * 0.25 + corroboration - conflictsPenalty)));
  return { ...candidate, independentSourceGroups: groups.size, confidence, confidenceBreakdown: { sourceTrust: Math.round(trust * 100), freshness, corroboration, conflictsPenalty, independentSourceGroups: groups.size } };
}

module.exports = { scoreCandidate };
