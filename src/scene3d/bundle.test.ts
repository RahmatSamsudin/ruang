import { describe, expect, it, vi } from 'vitest'
import {
  base64ToBytes,
  bytesToBase64,
  exportBundle,
  importBundle,
  type RuangBundle,
} from './bundle.ts'
import type { ModelItem, PropItem, ScenePatch } from './scene.ts'

describe('bundle', () => {
  const samplePatch: ScenePatch = {
    version: 2,
    overrides: { 'desk-1': { rotation: 1.57 } },
    added: [
      {
        kind: 'model',
        id: 'added-1',
        level: 0,
        modelId: 'm-aaaaaaaaaaaa',
        position: [1, 0, 2],
      } as ModelItem,
      {
        kind: 'prop',
        id: 'added-2',
        level: 0,
        type: 'Plant',
        position: [2, 0, 3],
        rotation: 0,
      } as PropItem,
    ],
  }

  it('encodes and decodes base64 bytes symmetrically', () => {
    const original = new Uint8Array([0, 1, 2, 255, 128, 64, 32, 16])
    const b64 = bytesToBase64(original)
    const decoded = base64ToBytes(b64)
    expect(Array.from(decoded)).toEqual(Array.from(original))
  })

  it('exports scene patch and referenced models into a RuangBundle', async () => {
    const fetchModel = vi.fn().mockImplementation(async (id: string) => {
      if (id === 'm-aaaaaaaaaaaa') {
        return {
          name: 'chair.glb',
          format: 'glb' as const,
          bytes: new Uint8Array([10, 20, 30, 40]),
        }
      }
      return null
    })

    const bundle = await exportBundle(samplePatch, { fetchModel })
    expect(bundle.format).toBe('ruang-bundle')
    expect(bundle.version).toBe(1)
    expect(bundle.patch.version).toBe(2)
    expect(bundle.models.length).toBe(1)
    expect(bundle.models[0].id).toBe('m-aaaaaaaaaaaa')
    expect(bundle.models[0].name).toBe('chair.glb')
    expect(bundle.models[0].format).toBe('glb')
    expect(base64ToBytes(bundle.models[0].dataBase64)).toEqual(new Uint8Array([10, 20, 30, 40]))
  })

  it('imports bundle, uploads models, remaps modelIds, and resolves item id collisions', async () => {
    const bundle: RuangBundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      patch: {
        version: 2,
        overrides: { 'stock-chair': { position: [0, 0, 0] } },
        added: [
          {
            kind: 'model',
            id: 'added-1', // Collides with existing 'added-1'
            level: 0,
            modelId: 'm-oldmodel1111',
            position: [5, 0, 5],
          } as ModelItem,
        ],
      },
      models: [
        {
          id: 'm-oldmodel1111',
          name: 'table.glb',
          format: 'glb',
          dataBase64: bytesToBase64(new Uint8Array([1, 2, 3])),
        },
      ],
    }

    const uploadModel = vi.fn().mockResolvedValue({ id: 'm-newmodel2222' })

    const existing: ScenePatch = {
      version: 2,
      overrides: { 'desk-1': null },
      added: [
        {
          kind: 'model',
          id: 'added-1',
          level: 0,
          modelId: 'm-existing0000',
          position: [0, 0, 0],
        } as ModelItem,
      ],
    }

    const result = await importBundle(bundle, existing, { uploadModel })

    expect(uploadModel).toHaveBeenCalledWith('table.glb', 'glb', expect.any(Uint8Array))
    expect(result.version).toBe(2)
    expect(result.overrides).toHaveProperty('desk-1')
    expect(result.overrides).toHaveProperty('stock-chair')
    expect(result.added.length).toBe(2)
    expect(result.added[0].id).toBe('added-1')
    expect(result.added[1].id).toBe('added-2') // Renamed due to collision
    expect((result.added[1] as ModelItem).modelId).toBe('m-newmodel2222') // Remapped ID
  })

  it('rejects invalid bundle format or version', async () => {
    const invalid = { format: 'unknown', version: 1, patch: {}, models: [] }
    await expect(importBundle(invalid as unknown as RuangBundle, samplePatch)).rejects.toThrow(
      "Invalid bundle format: expected 'ruang-bundle'",
    )

    const invalidVer = { format: 'ruang-bundle', version: 99, patch: {}, models: [] }
    await expect(importBundle(invalidVer as unknown as RuangBundle, samplePatch)).rejects.toThrow(
      'Unsupported bundle version: expected 1',
    )
  })

  it('rejects bundles exceeding model count cap', async () => {
    const tooManyModels = Array.from({ length: 25 }, (_, i) => ({
      id: `m-${i}`,
      name: `model-${i}.glb`,
      format: 'glb' as const,
      dataBase64: '',
    }))

    const bundle: RuangBundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: '',
      patch: { version: 2, overrides: {}, added: [] },
      models: tooManyModels,
    }

    await expect(importBundle(bundle, samplePatch)).rejects.toThrow(
      'Bundle contains 25 models, exceeding cap of 20',
    )
  })
})
