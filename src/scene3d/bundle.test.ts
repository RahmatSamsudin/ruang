import { describe, expect, it, vi } from 'vitest'
import {
  base64ToBytes,
  bytesToBase64,
  createMinimalGlb,
  exportBundle,
  formatBundleFilename,
  importBundle,
  type BundledModel,
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

  it('formats bundle filename correctly', () => {
    const fixedDate = new Date(2026, 9, 14, 15, 30) // month is 0-indexed: 9 = October
    expect(formatBundleFilename(fixedDate)).toBe('ruang-bundle-20261014-1530.json')
  })

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
          bytes: createMinimalGlb(),
        }
      }
      return null
    })

    const bundle = await exportBundle(samplePatch, { fetchModel })
    expect(bundle.format).toBe('ruang-bundle')
    expect(bundle.version).toBe(1)
    expect(bundle.patch.version).toBe(2)
    expect(bundle.patch.overrides).toEqual({})
    expect(bundle.models.length).toBe(1)
    expect(bundle.models[0].id).toBe('m-aaaaaaaaaaaa')
    expect(bundle.models[0].name).toBe('chair.glb')
    expect(bundle.models[0].format).toBe('glb')
    expect(base64ToBytes(bundle.models[0].dataBase64)).toEqual(createMinimalGlb())
  })

  it('imports bundle, uploads models, remaps modelIds, and resolves item id collisions', async () => {
    const glbBytes = createMinimalGlb()
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
          dataBase64: bytesToBase64(glbBytes),
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
    expect(result.overrides).not.toHaveProperty('stock-chair')
    expect(result.added.length).toBe(2)
    expect(result.added[0].id).toBe('added-1')
    expect(result.added[1].id).toBe('added-2') // Renamed due to collision
    expect((result.added[1] as ModelItem).modelId).toBe('m-newmodel2222') // Remapped ID
    expect(result.itemCount).toBe(1)
    expect(result.modelCount).toBe(1)
  })

  it('importing same bundle twice into same scene yields re-id items and 2 copies of models without collision', async () => {
    const glbBytes = createMinimalGlb()
    const bundle: RuangBundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      patch: {
        version: 2,
        overrides: {},
        added: [
          {
            kind: 'model',
            id: 'm-item-1',
            level: 0,
            modelId: 'm-source0001',
            position: [1, 0, 1],
          } as ModelItem,
        ],
      },
      models: [
        {
          id: 'm-source0001',
          name: 'lamp.glb',
          format: 'glb',
          dataBase64: bytesToBase64(glbBytes),
        },
      ],
    }

    let uploadCount = 0
    const uploadModel = vi.fn().mockImplementation(async () => {
      uploadCount++
      return { id: `m-assigned000${uploadCount}` }
    })

    const initial: ScenePatch = { version: 2, overrides: {}, added: [] }
    const firstImport = await importBundle(bundle, initial, { uploadModel })

    expect(firstImport.added.length).toBe(1)
    expect(firstImport.added[0].id).toBe('m-item-1')
    expect((firstImport.added[0] as ModelItem).modelId).toBe('m-assigned0001')

    // Second import into the result of the first import
    const secondImport = await importBundle(bundle, firstImport, { uploadModel })
    expect(secondImport.added.length).toBe(2)
    expect(secondImport.added[0].id).toBe('m-item-1')
    expect((secondImport.added[0] as ModelItem).modelId).toBe('m-assigned0001')
    // Second item should have remapped unique ID and newly assigned model ID
    expect(secondImport.added[1].id).toBe('added-1')
    expect((secondImport.added[1] as ModelItem).modelId).toBe('m-assigned0002')
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

  it('rejects bundles exceeding model count cap (20)', async () => {
    const tooManyModels = Array.from({ length: 21 }, (_, i) => ({
      id: `m-0000000000${i.toString().padStart(2, '0')}`,
      name: `model-${i}.glb`,
      format: 'glb' as const,
      dataBase64: bytesToBase64(createMinimalGlb()),
    }))

    const bundle: RuangBundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: '',
      patch: { version: 2, overrides: {}, added: [] },
      models: tooManyModels,
    }

    await expect(importBundle(bundle, samplePatch)).rejects.toThrow(
      'Bundle contains 21 models, exceeding cap of 20',
    )
  })

  it('rejects bundles exceeding item count cap (500)', async () => {
    const tooManyItems = Array.from({ length: 501 }, (_, i) => ({
      id: `item-${i}`,
      kind: 'prop' as const,
      type: 'Plant' as const,
      level: 0,
      position: [0, 0, 0] as [number, number, number],
    }))

    const bundle: RuangBundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: '',
      patch: { version: 2, overrides: {}, added: tooManyItems },
      models: [],
    }

    await expect(importBundle(bundle, samplePatch)).rejects.toThrow(
      'Bundle contains 501 items, exceeding cap of 500',
    )
  })

  it('rejects bundle with bad base64 before upload', async () => {
    const uploadModel = vi.fn()
    const bundle: RuangBundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: '',
      patch: {
        version: 2,
        overrides: {},
        added: [{ id: 'm-1', kind: 'model', modelId: 'm-model0000001', level: 0, position: [0, 0, 0] }],
      },
      models: [
        {
          id: 'm-model0000001',
          name: 'bad.glb',
          format: 'glb',
          dataBase64: '!!!NOT_VALID_BASE64@@@',
        },
      ],
    }

    await expect(importBundle(bundle, samplePatch, { uploadModel })).rejects.toThrow(
      'Invalid base64 encoding',
    )
    expect(uploadModel).not.toHaveBeenCalled()
  })

  it('rejects bundle with invalid model bytes before upload', async () => {
    const uploadModel = vi.fn()
    const bundle: RuangBundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: '',
      patch: {
        version: 2,
        overrides: {},
        added: [{ id: 'm-1', kind: 'model', modelId: 'm-model0000001', level: 0, position: [0, 0, 0] }],
      },
      models: [
        {
          id: 'm-model0000001',
          name: 'corrupt.glb',
          format: 'glb',
          dataBase64: bytesToBase64(new Uint8Array([1, 2, 3, 4, 5])),
        },
      ],
    }

    await expect(importBundle(bundle, samplePatch, { uploadModel })).rejects.toThrow(
      'not a valid GLB: file too short',
    )
    expect(uploadModel).not.toHaveBeenCalled()
  })

  it('rejects prototype pollution attempts before upload', async () => {
    const uploadModel = vi.fn()
    const maliciousJson = JSON.stringify({
      format: 'ruang-bundle',
      version: 1,
      exportedAt: '',
      patch: {
        version: 2,
        overrides: {},
        added: [],
      },
      models: [],
      constructor: { prototype: { admin: true } },
    })

    await expect(importBundle(maliciousJson, samplePatch, { uploadModel })).rejects.toThrow(
      'Forbidden key "constructor"',
    )

    const maliciousProto = '{"format":"ruang-bundle","version":1,"patch":{"version":2,"overrides":{},"added":[]},"models":[],"__proto__":{"polluted":true}}'
    await expect(importBundle(maliciousProto, samplePatch, { uploadModel })).rejects.toThrow(
      /Prototype safety violation|Forbidden key/,
    )

    const forbiddenIdBundle = {
      format: 'ruang-bundle' as const,
      version: 1 as const,
      exportedAt: '',
      patch: {
        version: 2 as const,
        overrides: {},
        added: [
          {
            id: '__proto__',
            kind: 'prop' as const,
            type: 'Plant' as const,
            level: 0,
            position: [0, 0, 0] as [number, number, number],
          },
        ],
      },
      models: [],
    }
    await expect(importBundle(forbiddenIdBundle, samplePatch, { uploadModel })).rejects.toThrow(
      'invalid id: __proto__',
    )

    expect(uploadModel).not.toHaveBeenCalled()
  })

  it('rolls back uploaded models when mid-import failure occurs', async () => {
    const glb = createMinimalGlb()
    const bundle: RuangBundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: '',
      patch: {
        version: 2,
        overrides: {},
        added: [
          { id: 'm-1', kind: 'model', modelId: 'm-model0000001', level: 0, position: [0, 0, 0] },
          { id: 'm-2', kind: 'model', modelId: 'm-model0000002', level: 0, position: [0, 0, 0] },
        ],
      },
      models: [
        {
          id: 'm-model0000001',
          name: 'model1.glb',
          format: 'glb',
          dataBase64: bytesToBase64(glb),
        },
        {
          id: 'm-model0000002',
          name: 'model2.glb',
          format: 'glb',
          dataBase64: bytesToBase64(glb),
        },
      ],
    }

    const uploadModel = vi
      .fn()
      .mockResolvedValueOnce({ id: 'm-uploaded1111' })
      .mockRejectedValueOnce(new Error('Storage quota exceeded 409'))

    const deleteModel = vi.fn().mockResolvedValue(undefined)

    await expect(
      importBundle(bundle, samplePatch, { uploadModel, deleteModel }),
    ).rejects.toThrow('Storage quota exceeded 409')

    expect(uploadModel).toHaveBeenCalledTimes(2)
    // deleteModel must be called for m-uploaded1111 to clean up!
    expect(deleteModel).toHaveBeenCalledWith('m-uploaded1111')
    expect(deleteModel).toHaveBeenCalledTimes(1)
  })

  it('drops bundle overrides on import without modifying existing overrides (append only contract)', async () => {
    const bundle: RuangBundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      patch: {
        version: 2,
        overrides: {
          'floor-main': null,
          'desk-2': { position: [999, 0, 999] },
        },
        added: [
          {
            kind: 'prop',
            id: 'added-p1',
            level: 0,
            type: 'Plant',
            position: [1, 0, 1],
          },
        ],
      },
      models: [],
    }

    const existing: ScenePatch = {
      version: 2,
      overrides: { 'desk-1': { rotation: 1.57 } },
      added: [],
    }

    const result = await importBundle(bundle, existing)
    expect(result.overrides).toEqual({ 'desk-1': { rotation: 1.57 } })
    expect(result.overrides).not.toHaveProperty('floor-main')
    expect(result.overrides).not.toHaveProperty('desk-2')
    expect(result.added.length).toBe(1)
  })

  it('rejects bundle item missing level', async () => {
    const bundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      patch: {
        version: 2,
        overrides: {},
        added: [{ kind: 'prop', id: 'p1', type: 'Plant', position: [0, 0, 0] }],
      },
      models: [],
    } as unknown as RuangBundle
    await expect(importBundle(bundle, samplePatch)).rejects.toThrow('Item p1 missing level')
  })

  it('rejects bundle model item missing position', async () => {
    const glbBytes = createMinimalGlb()
    const bundle: RuangBundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      patch: {
        version: 2,
        overrides: {},
        added: [{ kind: 'model', id: 'm1', level: 0, modelId: 'm-mod11111111' } as unknown as ModelItem],
      },
      models: [{ id: 'm-mod11111111', name: 'm.glb', format: 'glb', dataBase64: bytesToBase64(glbBytes) }],
    }
    await expect(importBundle(bundle, samplePatch)).rejects.toThrow('Item m1 missing position')
  })

  it('rejects bundle floor item with invalid surface extra property', async () => {
    const bundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      patch: {
        version: 2,
        overrides: {},
        added: [
          {
            kind: 'floor',
            id: 'f1',
            level: 0,
            min: [0, 0],
            max: [4, 4],
            y: 0,
            surface: { type: 'wood', repeat: [1, 1], extra: 'evil' },
          },
        ],
      },
      models: [],
    } as unknown as RuangBundle
    await expect(importBundle(bundle, samplePatch)).rejects.toThrow('Item f1 has invalid surface')
  })

  it('rejects bundle item with forbidden or unexpected field', async () => {
    const bundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      patch: {
        version: 2,
        overrides: {},
        added: [{ kind: 'prop', id: 'p1', level: 0, type: 'Plant', position: [0, 0, 0], extraField: true }],
      },
      models: [],
    } as unknown as RuangBundle
    await expect(importBundle(bundle, samplePatch)).rejects.toThrow(
      'Item p1 contains forbidden or unexpected field "extraField"',
    )
  })

  it('rejects import when existing + bundle items exceed 500 cap', async () => {
    const makeItems = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, i) => ({
        kind: 'prop' as const,
        id: `${prefix}-${i}`,
        level: 0,
        type: 'Plant' as const,
        position: [0, 0, 0] as [number, number, number],
      }))

    const existing: ScenePatch = {
      version: 2,
      overrides: {},
      added: makeItems(300, 'existing'),
    }

    const bundle: RuangBundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      patch: {
        version: 2,
        overrides: {},
        added: makeItems(201, 'bundle'),
      },
      models: [],
    }

    await expect(importBundle(bundle, existing)).rejects.toThrow(
      'Import would result in 501 items, exceeding cap of 500',
    )
  })

  it('rejects bundle containing duplicate model ids', async () => {
    const glbBytes = createMinimalGlb()
    const bundle: RuangBundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      patch: {
        version: 2,
        overrides: {},
        added: [],
      },
      models: [
        { id: 'm-dup11111111', name: 'one.glb', format: 'glb', dataBase64: bytesToBase64(glbBytes) },
        { id: 'm-dup11111111', name: 'two.glb', format: 'glb', dataBase64: bytesToBase64(glbBytes) },
      ],
    }

    await expect(importBundle(bundle, samplePatch)).rejects.toThrow(
      'Bundle contains duplicate model id: m-dup11111111',
    )
  })

  it('resolves item id collision with built-in default scene items', async () => {
    const bundle: RuangBundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      patch: {
        version: 2,
        overrides: {},
        added: [
          {
            kind: 'floor',
            id: 'floor-main',
            level: 0,
            min: [-10, -10],
            max: [10, 10],
            y: 0,
            surface: { type: 'wood', repeat: [1, 1] },
          },
        ],
      },
      models: [],
    }

    const result = await importBundle(bundle, { version: 2, overrides: {}, added: [] })
    expect(result.added.length).toBe(1)
    expect(result.added[0].id).not.toBe('floor-main')
    expect(result.added[0].id).toBe('added-1')
  })

  it('exports only referenced models and omits duplicate patch.items', async () => {
    const glbBytes = createMinimalGlb()
    const fetchModel = vi.fn().mockImplementation(async (id: string) => {
      return { name: `${id}.glb`, format: 'glb' as const, bytes: glbBytes }
    })

    const patch: ScenePatch = {
      version: 2,
      overrides: {},
      added: [
        {
          kind: 'model',
          id: 'm-item',
          level: 0,
          modelId: 'm-referenced1',
          position: [1, 0, 1],
        },
        {
          kind: 'prop',
          id: 'p-item',
          level: 0,
          type: 'Plant',
          position: [2, 0, 2],
        },
      ],
    }

    const bundle = await exportBundle(patch, { fetchModel })
    expect(bundle.models.length).toBe(1)
    expect(bundle.models[0].id).toBe('m-referenced1')
    expect(bundle.patch.added.length).toBe(2)
    expect((bundle.patch as unknown as { items?: unknown }).items).toBeUndefined()
  })

  it('supports reading legacy bundles with patch.items when patch.added is omitted', async () => {
    const bundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      patch: {
        version: 1,
        overrides: {},
        items: [
          {
            kind: 'prop',
            id: 'legacy-p1',
            level: 0,
            type: 'Plant',
            position: [0, 0, 0],
          },
        ],
      },
      models: [],
    } as unknown as RuangBundle

    const result = await importBundle(bundle, { version: 2, overrides: {}, added: [] })
    expect(result.added.length).toBe(1)
    expect(result.added[0].id).toBe('legacy-p1')
  })

  it('reports orphan DELETE failure in error message during rollback', async () => {
    const glbBytes = createMinimalGlb()
    const bundle: RuangBundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      patch: {
        version: 2,
        overrides: {},
        added: [
          { kind: 'model', id: 'm1', level: 0, modelId: 'm-1', position: [0, 0, 0] },
          { kind: 'model', id: 'm2', level: 0, modelId: 'm-2', position: [0, 0, 0] },
        ],
      },
      models: [
        { id: 'm-1', name: 'one.glb', format: 'glb', dataBase64: bytesToBase64(glbBytes) },
        { id: 'm-2', name: 'two.glb', format: 'glb', dataBase64: bytesToBase64(glbBytes) },
      ],
    }

    let uploadCount = 0
    const uploadModel = vi.fn().mockImplementation(async () => {
      uploadCount++
      if (uploadCount === 2) {
        throw new Error('Upload failed 500')
      }
      return { id: 'm-orphan1' }
    })

    const deleteModel = vi.fn().mockRejectedValue(new Error('Network error on delete'))

    await expect(importBundle(bundle, samplePatch, { uploadModel, deleteModel })).rejects.toThrow(
      'Upload failed 500 (Rollback failed to delete orphan models: m-orphan1)',
    )
  })

  it('supports importing 12 models with progress callbacks and custom throttle', async () => {
    const glbBytes = createMinimalGlb()
    const models: BundledModel[] = Array.from({ length: 12 }, (_, i) => ({
      id: `m-bulk${String(i).padStart(8, '0')}`,
      name: `model-${i}.glb`,
      format: 'glb' as const,
      dataBase64: bytesToBase64(glbBytes),
    }))
    const added: ModelItem[] = models.map((m, i) => ({
      kind: 'model',
      id: `item-${i}`,
      level: 0,
      modelId: m.id,
      position: [i, 0, 0],
    }))

    const bundle: RuangBundle = {
      format: 'ruang-bundle',
      version: 1,
      exportedAt: new Date().toISOString(),
      patch: { version: 2, overrides: {}, added },
      models,
    }

    const progressReports: string[] = []
    const uploadModel = vi.fn().mockImplementation(async (name) => ({ id: `uploaded-${name}` }))

    const result = await importBundle(bundle, samplePatch, {
      uploadModel,
      throttleMs: 1,
      onProgress: (p) => progressReports.push(p.name),
    })

    expect(result.modelCount).toBe(12)
    expect(result.itemCount).toBe(12)
    expect(progressReports.length).toBe(12)
    expect(uploadModel).toHaveBeenCalledTimes(12)
  })
})
