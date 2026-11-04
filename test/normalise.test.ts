import { describe, expect, it } from 'vitest';
import {
  fromBetterstack,
  fromInstatus,
  fromStatuspageComponent,
  fromStatuspageImpact,
  fromStatuspageIndicator,
  matchesFilter,
  missingFilterEntries,
  worstStatus,
} from '../src/normalise.js';

describe('worstStatus', () => {
  it('picks the most severe status', () => {
    expect(worstStatus(['operational', 'degraded', 'maintenance'])).toBe('degraded');
  });
  it('ignores unknown when anything else is present', () => {
    expect(worstStatus(['unknown', 'operational'])).toBe('operational');
  });
  it('returns unknown when only unknown is present', () => {
    expect(worstStatus(['unknown'])).toBe('unknown');
  });
  it('defaults empty input to operational', () => {
    expect(worstStatus([])).toBe('operational');
  });
  it('honours a fallback for empty input', () => {
    expect(worstStatus([], 'unknown')).toBe('unknown');
  });
});

describe('fromStatuspageComponent', () => {
  it.each([
    ['operational', 'operational'],
    ['degraded_performance', 'degraded'],
    ['partial_outage', 'partial_outage'],
    ['major_outage', 'major_outage'],
    ['under_maintenance', 'maintenance'],
    ['weird', 'unknown'],
  ])('%s -> %s', (input, expected) => {
    expect(fromStatuspageComponent(input)).toBe(expected);
  });
});

describe('fromStatuspageIndicator', () => {
  it.each([
    ['none', 'operational'],
    ['minor', 'degraded'],
    ['major', 'partial_outage'],
    ['critical', 'major_outage'],
    ['maintenance', 'maintenance'],
  ])('%s -> %s', (input, expected) => {
    expect(fromStatuspageIndicator(input)).toBe(expected);
  });
});

describe('fromStatuspageImpact', () => {
  it.each([
    ['none', 'degraded'],
    ['minor', 'degraded'],
    ['major', 'partial_outage'],
    ['critical', 'major_outage'],
    ['maintenance', 'maintenance'],
  ])('%s -> %s', (input, expected) => {
    expect(fromStatuspageImpact(input)).toBe(expected);
  });
});

describe('fromInstatus', () => {
  it.each([
    ['OPERATIONAL', 'operational'],
    ['UP', 'operational'],
    ['DEGRADEDPERFORMANCE', 'degraded'],
    ['HASISSUES', 'degraded'],
    ['PARTIALOUTAGE', 'partial_outage'],
    ['SOMEPARTIALOUTAGE', 'partial_outage'],
    ['MAJOROUTAGE', 'major_outage'],
    ['ALLMAJOROUTAGE', 'major_outage'],
    ['SOMEMAJOROUTAGE', 'partial_outage'],
    ['UNDERMAINTENANCE', 'maintenance'],
    ['ALLUNDERMAINTENANCE', 'maintenance'],
    ['SOMETHINGELSE', 'degraded'],
  ])('%s -> %s', (input, expected) => {
    expect(fromInstatus(input)).toBe(expected);
  });
});

describe('fromBetterstack', () => {
  it.each([
    ['operational', 'operational'],
    ['degraded', 'degraded'],
    ['downtime', 'major_outage'],
    ['maintenance', 'maintenance'],
    ['resolved', 'operational'],
    ['not_monitored', null],
  ])('%s -> %s', (input, expected) => {
    expect(fromBetterstack(input)).toBe(expected);
  });
});

describe('matchesFilter', () => {
  it('matches case-insensitively', () => {
    expect(matchesFilter(['Media Streams US1', 'PROGRAMMABLE VOICE US1'], ['programmable voice us1'])).toBe(true);
  });
  it('matches everything when no filter is given', () => {
    expect(matchesFilter(['x'], undefined)).toBe(true);
  });
  it('is exact, not substring', () => {
    expect(matchesFilter(['Voice, APAC'], ['Voice'])).toBe(false);
  });
});

describe('missingFilterEntries', () => {
  it('lists filter entries that match no component', () => {
    expect(missingFilterEntries(['Gmail', 'Google Calendar'], ['Gmail', 'Gmial'])).toEqual(['Gmial']);
  });
});
