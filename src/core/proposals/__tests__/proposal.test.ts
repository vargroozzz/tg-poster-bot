import { describe, it, expect } from 'vitest';
import {
  normalizeNickname,
  isNicknameTakenIn,
  canAcceptProposal,
  parseCommandName,
  resolveProposerCredit,
  MAX_PENDING_PROPOSALS,
  NON_OWNER_COMMANDS,
} from '../proposal.js';

describe('normalizeNickname', () => {
  it('trims and lowercases', () => {
    expect(normalizeNickname('  Alex  ')).toBe('alex');
  });
});

describe('isNicknameTakenIn', () => {
  const existing = [
    { userId: 1, nickname: 'Alex' },
    { userId: 2, nickname: 'Bob' },
  ];
  it('detects a case-insensitive duplicate owned by another user', () => {
    expect(isNicknameTakenIn(existing, 'alex')).toBe(true);
  });
  it('lets the same user keep their own name', () => {
    expect(isNicknameTakenIn(existing, 'ALEX', 1)).toBe(false);
  });
  it('allows a free name', () => {
    expect(isNicknameTakenIn(existing, 'Carol')).toBe(false);
  });
});

describe('canAcceptProposal', () => {
  it('always accepts confirmed users', () => {
    expect(canAcceptProposal('confirmed', 999, MAX_PENDING_PROPOSALS)).toBe(true);
  });
  it('accepts unconfirmed under the cap', () => {
    expect(canAcceptProposal('unconfirmed', 2, 3)).toBe(true);
  });
  it('blocks unconfirmed at the cap', () => {
    expect(canAcceptProposal('unconfirmed', 3, 3)).toBe(false);
  });
});

describe('parseCommandName', () => {
  it('extracts the command, stripping mention and args, lowercased', () => {
    expect(parseCommandName('/SetNickname@my_bot Alex')).toBe('setnickname');
  });
  it('returns undefined for non-commands', () => {
    expect(parseCommandName('hello')).toBeUndefined();
    expect(parseCommandName(undefined)).toBeUndefined();
  });
});

describe('resolveProposerCredit', () => {
  it('owner credits the content source', () => {
    expect(resolveProposerCredit(true, 10, 55)).toBe(55);
  });
  it('proposer is credited with their own id', () => {
    expect(resolveProposerCredit(false, 10, 55)).toBe(10);
  });
});

describe('constants', () => {
  it('exposes the allowlist and cap', () => {
    expect(NON_OWNER_COMMANDS).toContain('setnickname');
    expect(MAX_PENDING_PROPOSALS).toBeGreaterThan(0);
  });
});
