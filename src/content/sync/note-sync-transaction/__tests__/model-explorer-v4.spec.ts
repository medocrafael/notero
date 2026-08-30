import { beforeAll, describe, expect, it } from 'vite-plus/test';

import { TRANSITION_REGISTRY } from '../transition-registry';

import {
  exploreModelV4,
  PROPERTY_IDS_V4,
  type ModelExplorerReportV4,
} from './model-harness-v4';

describe('FSM v2 deterministic bounded production model explorer', () => {
  let report: ModelExplorerReportV4;

  beforeAll(async () => {
    report = await exploreModelV4(4);
  }, 60_000);

  it.each(PROPERTY_IDS_V4)(
    '%s has a passing explorer assertion and at least one explored witness',
    (property) => {
      expect(report.properties[property].failures).toStrictEqual([]);
      expect(report.properties[property].passed).toBe(true);
      expect(report.properties[property].witnesses).toBeGreaterThan(0);
    },
  );

  it('reports actual state count, canonical pruning, and no counterexample', () => {
    expect(report.exploredStates).toBeGreaterThan(20);
    expect(report.exploredEdges).toBeGreaterThan(report.exploredStates);
    expect(report.prunedStates).toBeGreaterThan(0);
    expect(report.canonicalizationRules).toHaveLength(5);
    expect(report.processRestartChecks).toBeGreaterThan(0);
    expect(report.shortestCounterexample).toBeNull();
  });

  it('gives every M01-M24 production transition a reachable witness', () => {
    const registryIDs = TRANSITION_REGISTRY.map(({ id }) => id);

    expect(report.transitionCoverage).toStrictEqual({
      covered: registryIDs.length,
      missing: [],
      total: registryIDs.length,
    });
    expect(Object.keys(report.transitionWitnesses).toSorted()).toStrictEqual(
      registryIDs.toSorted(),
    );
  });
});
