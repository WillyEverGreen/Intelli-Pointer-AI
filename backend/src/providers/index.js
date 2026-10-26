import { gemini } from './gemini.js';
import { openaiCompat } from './openaiCompat.js';

// Provider registry. Public model ids are "<provider>/<model>" so two
// providers can expose the same upstream model name without colliding.
const PROVIDERS = [gemini, openaiCompat];

export function listModels() {
  return PROVIDERS.filter((p) => p.enabled()).flatMap((p) =>
    p.models().map((m) => ({ ...m, id: `${p.id}/${m.id}`, provider: p.id, providerLabel: p.label, upstreamId: m.id })),
  );
}

export function resolveModel(publicId) {
  const model = listModels().find((m) => m.id === publicId);
  if (!model) return null;
  return { model, provider: PROVIDERS.find((p) => p.id === model.provider) };
}
