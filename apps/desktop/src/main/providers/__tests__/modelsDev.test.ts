import { describe, expect, it, beforeEach } from 'vitest';
import { enrichProviderModels, resetModelsDevCacheForTests } from '../modelsDev';
import type { FetchLike } from '../modelCatalog';

describe('modelsDev enrichProviderModels', () => {
  beforeEach(() => {
    resetModelsDevCacheForTests();
  });

  it('adds catalogName when the catalog lists the model id', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('models.dev')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            demo: {
              models: {
                'gpt-4o': { name: 'GPT-4o', reasoning: false },
              },
            },
          }),
        };
      }
      throw new Error('unexpected url');
    };

    const out = await enrichProviderModels([{ id: 'gpt-4o' }], fetchImpl);
    expect(out[0]?.catalogName).toBe('GPT-4o');
  });
});
