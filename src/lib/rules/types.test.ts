import { describe, expect, it } from 'vitest';
import {
  categoryKind,
  memberKind,
  ruleMatchType,
  systemCategoryKey,
  transferStatus,
} from '@/db/schema';
import {
  CATEGORY_KINDS,
  MEMBER_KINDS,
  RULE_MATCH_TYPES,
  SYSTEM_CATEGORY_KEYS,
  TRANSFER_STATUSES,
} from './types';

describe('rule types match db enums（schema.md §1）', () => {
  it('enum values are the same as src/db/schema.ts', () => {
    expect([...MEMBER_KINDS]).toEqual(memberKind.enumValues);
    expect([...CATEGORY_KINDS]).toEqual(categoryKind.enumValues);
    expect([...SYSTEM_CATEGORY_KEYS]).toEqual(systemCategoryKey.enumValues);
    expect([...RULE_MATCH_TYPES]).toEqual(ruleMatchType.enumValues);
    expect([...TRANSFER_STATUSES]).toEqual(transferStatus.enumValues);
  });
});
