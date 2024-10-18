import { on } from 'events'
import { setInterval } from 'timers/promises'

import {
  EComputationMethod,
  HeightmapViewer,
  TerrainViewer,
  VoxelmapViewer,
} from '@aresrpg/aresrpg-engine'
import { aiter } from 'iterator-helper'
import { Box2, Color, Vector2, Vector3 } from 'three'
import {
  ChunkFactory,
  PatchContainer,
  GroundMap,
  WorldComputeProxy,
  WorldUtils,
  SchematicLoader,
  ItemsInventory,
  ProceduralItemGenerator,
} from '@aresrpg/aresrpg-world'

import { current_three_character } from '../game/game.js'
import { abortable, typed_on } from '../utils/iterator.js'
import {
  chunk_data_encoder,
  setup_board_container,
  to_engine_chunk_format,
} from '../utils/terrain/world_utils.js'
import {
  block_color_mapping,
  proc_items_conf,
} from '../utils/terrain/world_conf.js'
import {
  SCHEMPACKS,
  schem_blocks_mapping,
} from '../utils/terrain/schem_conf.js'

const LOD_MODE = {
  NONE: 0,
  STATIC: 1,
  DYNAMIC: 2,
}
// used to turn on/ turn off specific feat
const FLAGS = {
  LOD_MODE: LOD_MODE.STATIC, // should be set to STATIC to avoid unneeded computations
  BOARD_POC: false, // temporary toggle until board integration is done
  OTF_GEN: true, // when enabled patches will be baked progressively
}
// settings
const altitude = { min: -1, max: 400 }

// primary world worker
const world_worker = new Worker(
  new URL('../utils/terrain/world_compute_worker.js', import.meta.url),
  { type: 'module' },
)

// used for delegating LOD computations to avoid monopolizing primary worker
const delegated_tasks_worker = new Worker(
  new URL('../utils/terrain/world_compute_worker.js', import.meta.url),
  { type: 'module' },
)

const voxel_materials_list = Object.values(block_color_mapping).map(col => ({
  color: new Color(col),
}))

const last_board = {
  pos: new Vector3(10, 0, 10),
  bounds: new Box2(),
  handler: null,
}
let pending_task = false

const board_refresh_trigger = current_pos => {
  return (
    WorldUtils.asVect2(last_board.pos).distanceTo(
      WorldUtils.asVect2(current_pos),
    ) > 1
  )
}

/** @type {Type.Module} */
export default function () {
  // WORLD
  // Common settings
  const patch_size = { xz: 64, y: 64 }
  const min_patch_id_y = Math.floor(altitude.min / patch_size.y)
  const max_patch_id_y = Math.floor(altitude.max / patch_size.y)
  // Run world-compute module in dedicated worker
  WorldComputeProxy.instance.worker = world_worker
  // alternative proxy to route to secondary worker
  const world_delegated_proxy = new WorldComputeProxy()
  world_delegated_proxy.worker = delegated_tasks_worker
  // default chunk factory
  ChunkFactory.default.chunkDataEncoder = chunk_data_encoder
  ChunkFactory.default.setChunksGenRange(min_patch_id_y, max_patch_id_y)
  // populate inventory with schematics and procedural objects
  SchematicLoader.worldBlocksMapping = schem_blocks_mapping
  SchematicLoader.chunkDataEncoder = chunk_data_encoder
  ProceduralItemGenerator.chunkDataEncoder = chunk_data_encoder
  ItemsInventory.externalResources.procItemsConfigs = proc_items_conf
  ItemsInventory.externalResources.schemFileUrls = { ...SCHEMPACKS.TREES.files }

  // ground patch container
  const ground_patches = new GroundMap()
  // ENGINE
  const map = {
    minAltitude: altitude.min,
    maxAltitude: altitude.max,
    voxelMaterialsList: voxel_materials_list,
    getLocalMapData: async (block_start, block_end) => {
      return null
    },
    async sampleHeightmap(coords) {
      console.log(`block batch compute size: ${coords.length}`)
      const pos_batch = coords.map(({ x, z }) => new Vector2(x, z))
      const res = await world_delegated_proxy.computeBlocksBatch(pos_batch, {
        includeEntitiesBlocks: true,
      })
      const data = res.map(block => ({
        altitude: block.pos.y + 0.25,
        color: new Color(block_color_mapping[block.data.type]),
      }))
      return data
    },
  }

  const voxelmap_viewer = new VoxelmapViewer(
    min_patch_id_y,
    max_patch_id_y,
    voxel_materials_list,
    {
      patchSize: patch_size,
      computationOptions: {
        method: EComputationMethod.CPU_MULTITHREADED,
        threadsCount: 4,
      },
      voxelsChunkOrdering: 'zxy',
    },
  )
  const heightmap_viewer = new HeightmapViewer(map, {
    basePatchSize: voxelmap_viewer.chunkSize.xz,
    voxelRatio: 2,
    maxLevel: 5,
  })
  const terrain_viewer = new TerrainViewer(heightmap_viewer, voxelmap_viewer)
  terrain_viewer.parameters.lod.enabled = FLAGS.LOD_MODE > 0

  // CHUNKS RENDERING
  const update_chunks_visibility = () => {
    const chunks_ids = Object.keys(ground_patches.patchLookup)
      .map(patch_key => WorldUtils.parsePatchKey(patch_key))
      .map(patch_id => ChunkFactory.default.genChunksIdsFromPatchId(patch_id))
      .flat()
    voxelmap_viewer.setVisibility(chunks_ids)
  }

  const render_chunk = world_chunk => {
    const engine_chunk = to_engine_chunk_format(world_chunk)
    voxelmap_viewer.invalidatePatch(engine_chunk.id)
    voxelmap_viewer.doesPatchRequireVoxelsData(engine_chunk.id) &&
      voxelmap_viewer.enqueuePatch(engine_chunk.id, engine_chunk)
  }

  const render_patch_chunks = async (patch, items) => {
    // assemble ground and entities to form world chunks
    const world_patch_chunks = await ChunkFactory.instance.chunkifyPatch(
      patch,
      items,
    )
    // feed engine with chunks
    world_patch_chunks.forEach(world_chunk => render_chunk(world_chunk))
    // If not using on-the-fly gen, delay patch processing to prevents
    // too many chunks rendering at the same time (TODO)
    // setTimeout(() =>
    //   patch.toChunks().forEach(chunk => render_chunk(chunk)),
    // )
  }

  // BATTLE BOARD POC
  const render_board_container = async board_container => {
    const extended_bounds = last_board.bounds.union(board_container.bounds)
    // duplicate and override patches with content from board
    const overridden_patches = ground_patches
      .getOverlappingPatches(extended_bounds)
      .map(patch => patch.duplicate())
    for await (const patch of overridden_patches) {
      PatchContainer.copySourceOverTargetContainer(board_container, patch)
      const entities_chunks = await WorldComputeProxy.instance.bakeEntities(
        patch.bounds,
      )
      // discard entities overlapping with the board
      const entities = entities_chunks.filter(
        entity_chunk =>
          !board_container.isOverlappingWithBoard(
            WorldUtils.asBox2(entity_chunk.entityData.bbox),
          ),
      )
      // rerender all patches overlapped by the board
      render_patch_chunks(patch, entities)
    }
  }

  return {
    tick() {
      terrain_viewer.update()
    },
    observe({ camera, events, signal, scene, get_state }) {
      window.dispatchEvent(new Event('assets_loading'))
      // this notify the player_movement module that the terrain is ready
      events.emit('CHUNKS_LOADED')

      scene.add(terrain_viewer.container)

      aiter(abortable(typed_on(events, 'STATE_UPDATED', { signal }))).reduce(
        async (
          { last_view_distance, last_far_view_distance },
          { settings: { view_distance, far_view_distance } },
        ) => {
          if (last_view_distance) {
            if (
              last_view_distance !== view_distance ||
              last_far_view_distance !== far_view_distance
            ) {
              // await reset_chunks(true)
            }
          }

          return {
            last_view_distance: view_distance,
            last_far_view_distance: far_view_distance,
          }
        },
      )

      aiter(abortable(setInterval(1000, null))).reduce(async () => {
        const state = get_state()
        const player_position =
          current_three_character(state)?.position?.clone()
        if (player_position) {
          if (!pending_task) {
            pending_task = true
            const current_pos = player_position.clone().floor()
            // BOARD REFRSH
            if (FLAGS.BOARD_POC && board_refresh_trigger(current_pos)) {
              const res = await setup_board_container(current_pos)
              if (res) {
                const { board_container, board_handler } = res

                // console.log(border_blocks)
                render_board_container(board_container)
                if (last_board.handler?.container) {
                  last_board.handler.dispose()
                  scene.remove(last_board.handler.container)
                }
                last_board.handler = board_handler
                scene.add(board_handler.container)
                // remember bounds for later board removal
                last_board.bounds = board_container.bounds
                last_board.pos = current_pos
              }
            }
            // PATCHES REFRESH
            // Query patches around player
            const view_center = WorldUtils.asVect2(current_pos)
            const view_radius = state.settings.view_distance
            const view_dims = new Vector2(
              view_radius,
              view_radius,
            ).multiplyScalar(2)
            const view_box = new Box2().setFromCenterAndSize(
              view_center,
              view_dims,
            )
            const has_changed = ground_patches.rebuildPatchIndex(view_box)
            if (has_changed) {
              const changes = await ground_patches.loadEmpty(FLAGS.OTF_GEN)
              update_chunks_visibility()
              // Bake world patches and sends chunks to engine
              for await (const patch of changes) {
                // request all entities belonging to this patch
                const overground_items =
                  await WorldComputeProxy.instance.queryOvergroundItems(
                    patch.bounds,
                  )
                render_patch_chunks(patch, overground_items)
              }
              terrain_viewer.setLod(camera.position, 50, camera.far)
            }
            pending_task = false
          }
        }
        FLAGS.LOD_MODE === LOD_MODE.DYNAMIC &&
          terrain_viewer.setLod(camera.position, 50, camera.far)
      })
    },
  }
}
