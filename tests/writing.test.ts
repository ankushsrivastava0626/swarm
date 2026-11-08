import { describe, expect, it } from 'vitest';
import { topicOf } from '../src/runtime/writing';

describe('topics for the colony to talk about', () => {
  it('names the thing a request is about', () => {
    expect(topicOf('Move billing onto the new ledger')).toBe('billing');
    expect(topicOf('Audit the checkout flow')).toBe('checkout flow');
    expect(topicOf('Draft the launch notes')).toBe('launch notes');
    expect(topicOf('Check the signup flow on mobile')).toBe('signup flow');
  });

  it('takes the subject of a question, not the whole question', () => {
    expect(topicOf('Why do refunds post twice?')).toBe('refunds');
    expect(topicOf('Find which emails bounce')).toBe('emails');
    expect(topicOf('Figure out why checkout hangs')).toBe('checkout');
  });
});
