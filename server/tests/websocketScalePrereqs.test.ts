import { describe, it, expect } from 'vitest';
import { assertWebsocketScalePrereqs } from '../websocket';

describe('assertWebsocketScalePrereqs', () => {
  it('no-ops in development regardless of REDIS_URL', () => {
    expect(() =>
      assertWebsocketScalePrereqs({
        NODE_ENV: 'development',
        FLY_MIN_MACHINES_RUNNING: '5',
        // no REDIS_URL
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('no-ops in production when single-machine (FLY_MIN_MACHINES_RUNNING unset)', () => {
    expect(() =>
      assertWebsocketScalePrereqs({
        NODE_ENV: 'production',
        // no FLY_MIN_MACHINES_RUNNING, no REDIS_URL
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('no-ops in production when single-machine (FLY_MIN_MACHINES_RUNNING=1)', () => {
    expect(() =>
      assertWebsocketScalePrereqs({
        NODE_ENV: 'production',
        FLY_MIN_MACHINES_RUNNING: '1',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('no-ops in production multi-machine when REDIS_URL is set', () => {
    expect(() =>
      assertWebsocketScalePrereqs({
        NODE_ENV: 'production',
        FLY_MIN_MACHINES_RUNNING: '3',
        REDIS_URL: 'redis://example.internal:6379',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('throws in production multi-machine when REDIS_URL is missing', () => {
    expect(() =>
      assertWebsocketScalePrereqs({
        NODE_ENV: 'production',
        FLY_MIN_MACHINES_RUNNING: '2',
      } as NodeJS.ProcessEnv),
    ).toThrow(/REDIS_URL must be set/);
  });

  it('throws in production multi-machine when REDIS_URL is the empty string', () => {
    // express-rate-limit-style env handling: an explicitly-empty value should
    // be treated the same as missing, not as "configured".
    expect(() =>
      assertWebsocketScalePrereqs({
        NODE_ENV: 'production',
        FLY_MIN_MACHINES_RUNNING: '4',
        REDIS_URL: '',
      } as NodeJS.ProcessEnv),
    ).toThrow(/REDIS_URL must be set/);
  });

  it('treats non-numeric FLY_MIN_MACHINES_RUNNING as single-machine (no throw)', () => {
    expect(() =>
      assertWebsocketScalePrereqs({
        NODE_ENV: 'production',
        FLY_MIN_MACHINES_RUNNING: 'auto',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});
