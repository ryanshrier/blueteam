import { describe, expect, test } from '@jest/globals';
import { isExcludedRecurringFeature } from '../lib/feeds.js';

const foodPost = {
  title: 'Friday Squid Blogging: Squid on a Stick at the New York State Fair',
  source: 'Schneier on Security',
  link: 'https://www.schneier.com/blog/archives/2026/09/friday-squid-blogging-squid-on-a-stick-at-the-new-york-state-fair.html',
};

describe('source-scoped recurring-feature admission', () => {
  test('excludes the observed food/open-discussion feature from the cyber edition', () => {
    expect(isExcludedRecurringFeature(foodPost, 'cyber')).toBe(true);
  });

  test.each([
    'Squid proxy vulnerability permits cache poisoning',
    'Researchers disclose a flaw in Squid',
    'New national cybersecurity policy',
  ])('retains substantive security coverage: %s', title => {
    expect(isExcludedRecurringFeature({ ...foodPost, title }, 'cyber')).toBe(false);
  });

  test('does not impose a cyber editorial exclusion on another edition or publisher', () => {
    expect(isExcludedRecurringFeature(foodPost, 'energy')).toBe(false);
    expect(isExcludedRecurringFeature({ ...foodPost, link: 'https://research.example/friday-squid-blogging' }, 'cyber')).toBe(false);
    expect(isExcludedRecurringFeature({ ...foodPost, link: 'https://schneier.com.attacker.example/post' }, 'cyber')).toBe(false);
  });
});
