/**
 * Tool Handlers Unit Tests
 *
 * Tests for the read_url tool handler (search_knowledge_base: integration/knowledge-base/searchKnowledgeBaseRoundtrip).
 */

import { executeToolCall } from '../../../src/services/tools/handlers';

// Mock fetch globally
const mockFetch = jest.fn();
(globalThis as any).fetch = mockFetch;



describe('web_search handler', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns error for missing query parameter', async () => {
    const result = await executeToolCall({ id: 'ws_1', name: 'web_search', arguments: {} });
    expect(result.error).toContain('Missing required parameter: query');
  });

  it('returns no-results message when search returns empty HTML', async () => {
    mockFetch.mockResolvedValue({ text: async () => '<html><body>Nothing here</body></html>' });
    const result = await executeToolCall({ id: 'ws_2', name: 'web_search', arguments: { query: 'xyzzy' } });
    expect(result.error).toBeUndefined();
    expect(result.content).toContain('No results found');
  });

  it('returns formatted results when search finds matches', async () => {
    const html = [
      '<div class="result-wrapper">',
      '<a href="https://example.com/page">Click me</a>',
      '<a class="title-link" href="https://example.com/page"><span class="title">Example Title</span></a>',
      '<p class="snippet">This is a snippet about the result</p>',
      '</div>',
    ].join('');
    mockFetch.mockResolvedValue({ text: async () => html });
    const result = await executeToolCall({ id: 'ws_3', name: 'web_search', arguments: { query: 'example' } });
    expect(result.error).toBeUndefined();
    expect(result.content).toBeDefined();
  });
});
