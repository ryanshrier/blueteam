import { describe, expect, test } from '@jest/globals';
import { actionRoleHtml } from '../public/modules/briefing/brief-action.js';

const text = html => html.replace(/<[^>]*>/g, '');

describe('authored action field presentation', () => {
  test('retains nested paragraph structure, all response conditions and links while styling owner and target', () => {
    const original = '<p class="brief-field" data-brief-field="act now">Infrastructure — inventory deployment; apply <a href="https://vendor.example/fix">the fixed build</a>. <strong>Initiation:</strong> start this shift. <strong>Completion criterion:</strong> record installed versions or an owned exception — recommended target September 6, 2026.</p>';
    const result = actionRoleHtml(original);
    expect(result).toContain('<p class="brief-field" data-brief-field="act now"><strong class="brief-action-owner">Infrastructure</strong>');
    expect(result).toContain('<strong class="brief-action-context-label">Initiation:</strong>');
    expect(result).toContain('<strong class="brief-action-context-label">Completion criterion:</strong>');
    expect(result).toContain('<span class="brief-action-target"> — recommended target September 6, 2026.</span></p>');
    expect(result).toContain('<a href="https://vendor.example/fix">the fixed build</a>');
    expect(text(result)).toBe(text(original));
    expect(actionRoleHtml(result)).toBe(result);
  });

  test('styles plain authored action context without deriving new instructions or changing their order', () => {
    const original = 'Application security — assess applicability. Initiation: start this shift. Dependencies: obtain vendor guidance. Evidence/artifact: inventory and advisory. Completion criterion: record version scope; keep unresolved gaps open — recommended target September 6, 2026.';
    const result = actionRoleHtml(original);
    for (const label of ['Initiation', 'Dependencies', 'Evidence/artifact', 'Completion criterion']) {
      expect(result).toContain(`<strong class="brief-action-context-label">${label}:</strong>`);
    }
    expect(text(result)).toBe(original);
    expect(actionRoleHtml(result)).toBe(result);
  });

  test('preserves existing owner markup and separates an explicit target in a later paragraph', () => {
    const original = '<p><strong title="Team">Incident response</strong> — investigate affected deployments.</p><p>Condition: confirmed exposure. Recovery: follow verified guidance — recommended target September 7, 2026.</p>';
    const result = actionRoleHtml(original);
    expect(result).toContain('<strong title="Team" class="brief-action-owner">Incident response</strong>');
    expect(result).toContain('<strong class="brief-action-context-label">Condition:</strong>');
    expect(result).toContain('<strong class="brief-action-context-label">Recovery:</strong>');
    expect(result).toContain('<span class="brief-action-target"> — recommended target September 7, 2026.</span></p>');
    expect(text(result)).toBe(text(original));
    expect(actionRoleHtml(result)).toBe(result);
  });

  test('leaves links, code, arbitrary bold text and non-field prose unchanged', () => {
    const original = 'Review <a href="https://vendor.example/?q=Condition: evidence" title="A > B">Condition: in a linked title</a> and <code>Recovery: command</code>. <strong>Important qualification</strong> remains in the sentence. This condition: is ordinary prose.';
    expect(actionRoleHtml(original)).toBe(original);
  });

  test('does not invent an owner or deadline for an action without explicit separators', () => {
    const original = '<p>Verify the vendor guidance before assigning a team. Completion criterion: preserve the signed record.</p>';
    const result = actionRoleHtml(original);
    expect(result).not.toContain('brief-action-owner');
    expect(result).not.toContain('brief-action-target');
    expect(result).toContain('<strong class="brief-action-context-label">Completion criterion:</strong>');
    expect(text(result)).toBe(text(original));
  });
});
