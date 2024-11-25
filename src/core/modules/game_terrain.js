import { setInterval } from 'timers/promises'

import {
  EComputationMethod,
  HeightmapViewer,
  TerrainViewer,
  VoxelmapViewer,
} from '@aresrpg/aresrpg-engine'
import { aiter } from 'iterator-helper'
import { Box2, Color, Vector2 } from 'three'
import {
  WorldComputeProxy,
  SchematicLoader,
  ItemsInventory,
  // Biome,
  Heightmap,
  BoardContainer,
  ChunkContainer,
  WorldConf,
  WorldChunkIndexer,
  ChunksOTFGenerator,
} from '@aresrpg/aresrpg-world'
import { Biome } from '@aresrpg/aresrpg-world/biomes'
import * as WorldUtils from '@aresrpg/aresrpg-world/worldUtils'

import { current_three_character } from '../game/game.js'
import { abortable, typed_on } from '../utils/iterator.js'
import {
  build_board_chunk,
  chunk_data_encoder,
  highlight_board,
  to_engine_chunk_format,
} from '../utils/terrain/world_utils.js'
import { setup_world_modules } from '../utils/terrain/world_setup.js'
import {
  CAVES_VIEW_DIST,
  BLOCKS_COLOR_MAPPING,
} from '../utils/terrain/config/world_settings.js'

// NB: LOD should be set to STATIC to limit over-computations
// and remove graphical issues
const LOD_MODE = {
  DISABLED: 0,
  STATIC: 1,
  DYNAMIC: 2,
}

const FLAGS = {
  LOD_MODE: LOD_MODE.DISABLED,
  BOARD_POC: false, // POC toggle until board integration is finished
  OTF_GEN: true, // bake patch progressively
}
// settings
const altitude = { min: -1, max: 400 }
// const world_worker_url = new URL(
//   '../utils/terrain/world_compute_worker.js',
//   import.meta.url,
// )

const voxel_materials_list = Object.values(BLOCKS_COLOR_MAPPING).map(col => ({
  color: new Color(col),
}))

const last_board = {
  pos: new Vector2(10, 10),
  bounds: new Box2(),
  handler: null,
}
const board_refresh_trigger = current_pos =>
  last_board.pos.distanceTo(current_pos) > 1

/** @type {Type.Module} */
export default function () {
  // WORLD
  // common settings
  const patch_size = { xz: 64, y: 64 }
  const min_patch_id_y = Math.floor(altitude.min / patch_size.y)
  const max_patch_id_y = Math.floor(altitude.max / patch_size.y)

  // common world setup
  setup_world_modules({
    heightmapInstance: Heightmap.instance,
    biomeInstance: Biome.instance,
    SchematicLoader,
    ItemsInventory,
    ChunkContainer,
  })
  // chunks related
  WorldConf.instance.chunkSettings.genRange.yMinId = min_patch_id_y
  WorldConf.instance.chunkSettings.genRange.yMaxId = max_patch_id_y
  ChunkContainer.dataEncoder = chunk_data_encoder

  // patch containers
  const chunks_indexer = new WorldChunkIndexer()
  const board_chunks_container = new BoardContainer()
  // ENGINE
  const map = {
    minAltitude: altitude.min,
    maxAltitude: altitude.max,
    voxelMaterialsList: voxel_materials_list,
    async sampleHeightmap(coords) {
      FLAGS.LOD_MODE === LOD_MODE.DYNAMIC &&
        console.log(`block batch compute size: ${coords.length}`)
      const pos_batch = coords.map(({ x, z }) => new Vector2(x, z))
      const res = await WorldComputeProxy.current.computeBlocksBatch(
        pos_batch,
        {
          includeEntitiesBlocks: true,
        },
      )
      const data = res.map(block => ({
        altitude: block.pos.y + 0.25,
        color: new Color(BLOCKS_COLOR_MAPPING[block.data.type]),
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

  // chunks rendering
  const render_chunk = world_chunk => {
    const engine_chunk = to_engine_chunk_format(world_chunk)
    voxelmap_viewer.invalidatePatch(engine_chunk.id)
    voxelmap_viewer.doesPatchRequireVoxelsData(engine_chunk.id) &&
      voxelmap_viewer.enqueuePatch(engine_chunk.id, engine_chunk)
  }

  return {
    tick() {
      terrain_viewer.update()
    },
    observe({ camera, events, signal, scene, get_state, physics }) {
      // CHUNKS RENDERING
      const update_chunks_visibility = () => {
        const chunks_ids = Object.keys(ground_patches.patchLookup)
          .map(patch_key => WorldUtils.parsePatchKey(patch_key))
          .map(patch_id =>
            ChunkFactory.default.genChunksIdsFromPatchId(patch_id),
          )
          .flat()
        voxelmap_viewer.setVisibility(chunks_ids)
      }

      const render_chunk = world_chunk => {
        const engine_chunk = to_engine_chunk_format(world_chunk)
        voxelmap_viewer.invalidatePatch(engine_chunk.id)
        voxelmap_viewer.doesPatchRequireVoxelsData(engine_chunk.id) &&
          voxelmap_viewer.enqueuePatch(
            engine_chunk.id,
            engine_chunk.voxels_chunk_data,
          )

        physics.voxelmap_collider.setChunk(
          engine_chunk.id,
          engine_chunk.voxels_chunk_data,
        )
      }

      const render_patch_chunks = (patch, items) => {
        // assemble ground and entities to form world chunks
        const world_patch_chunks = ChunkFactory.instance.chunkifyPatch(
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

      const transform_items_to_chunks = async overground_items => {
        const res = []
        for await (const [item_type, spawn_places] of Object.entries(
          overground_items,
        )) {
          for await (const spawn_origin of spawn_places) {
            const item_chunk = await ItemsInventory.getInstancedChunk(
              item_type,
              spawn_origin,
            )
            res.push(item_chunk)
          }
        }
        return res
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
          // request all entities belonging to this patch
          const overground_items =
            await WorldComputeProxy.instance.queryOvergroundItems(patch.bounds)
          // transform to chunk list
          const items_chunk_list =
            await transform_items_to_chunks(overground_items)
          // discard entities overlapping with the board
          const non_overlapping_chunks = items_chunk_list.filter(
            item_chunk =>
              !board_container.isOverlappingWithBoard(
                WorldUtils.asBox2(item_chunk.bounds),
              ),
          )
          // rerender all patches overlapped by the board
          render_patch_chunks(patch, non_overlapping_chunks)
        }
      }

      window.dispatchEvent(new Event('assets_loading'))
      // this notify the player_movement module that the terrain is ready

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
        // check at least one world compute unit is available
        if (player_position && WorldComputeProxy.workerPool) {
          const current_pos = player_position.clone().floor()
          // Query chunks around player position
          const view_center = WorldUtils.asVect2(current_pos).floor()
          const view_radius = state.settings.view_distance
          const caves_gen_bounds = WorldUtils.getBoundsAroundPos(
            view_center,
            CAVES_VIEW_DIST,
          )
          const added_patch_keys = chunks_indexer.reindexAroundPos(
            view_center,
            view_radius,
          )
          if (added_patch_keys.length > 0) {
            voxelmap_viewer.setVisibility(chunks_indexer.chunkIds)
            for await (const patch_key of added_patch_keys) {
              const chunk_generator = new ChunksOTFGenerator(patch_key)
              await chunk_generator.init()
              // process ground surface chunks first
              let chunks_keys = chunk_generator.groundSurfaceKeys
              let chunks_otf_gen = chunk_generator.otfChunkGen(chunks_keys)
              for await (const world_chunk of chunks_otf_gen) {
                render_chunk(world_chunk)
              }
              // process undeground chunks near player
              chunks_keys = chunk_generator.undegroundKeys
              chunks_otf_gen = chunk_generator.otfChunkGen(chunks_keys)
              for await (const world_chunk of chunks_otf_gen) {
                render_chunk(world_chunk)
              }
            }
            // override chunks around player with board buffer
            // const board_chunks_otf_gen =
            terrain_viewer.setLod(camera.position, 50, camera.far)
          }
          // BOARD
          if (FLAGS.BOARD_POC && board_refresh_trigger(view_center)) {
            // board_chunks_container.boardCenter = current_pos
            await board_chunks_container.localCache.cacheAroundPos(current_pos)
            // fill board buffer from cache
            const board_buffer =
              board_chunks_container.genBoardBuffer(current_pos)
            // iter board indexed chunks
            for (const board_chunk of board_chunks_container.localCache
              .cachedChunks) {
              // board_chunk.rawData.fill(113)
              const board_chunk_copy = new ChunkContainer(
                board_chunk.chunkKey,
                board_chunk.margin,
              )
              board_chunk.rawData.forEach(
                (val, i) =>
                  (board_chunk_copy.rawData[i] = chunk_data_encoder(val)),
              )
              // board_chunk_copy.rawData.set(board_chunk.rawData)
              ChunkContainer.copySourceToTarget(board_buffer, board_chunk_copy)
              // const board_chunk_mask = board_chunk.genBoardMask()
              // board_chunk_mask.applyMaskOnTargetChunk(board_chunk_copy)
              render_chunk(board_chunk_copy)
            }
            // process ground surface chunks first
            // const board_chunks_gen = await board_chunks_container.otfBoardGen()
            // for await (const board_chunk of board_chunks_gen) {
            //   render_chunk(board_chunk)
            // }
            //   board_container.setupBoard(view_center)
            //   const board_content = await board_container.genBoardContent()
            //   const otf_gen = await board_container.otfGen()
            //   for await (const board_patch of otf_gen) {
            //     // process external board items chunks
            //     const items_chunks = []
            //     const items_otf_gen = board_patch.itemsChunksOtfGen()
            //     for await (const item_chunk of items_otf_gen) {
            //       items_chunks.push(item_chunk)
            //     }
            //     const board_chunks = ChunkUtils.getWorldChunksFromPatchId(
            //       board_patch.id,
            //     )
            //     // generate board chunks
            //     for await (const board_chunk of board_chunks) {
            //       for (const item_chunk of items_chunks) {
            //         ChunkContainer.copySourceToTarget(item_chunk, board_chunk)
            //       }
            //       build_board_chunk(board_patch, board_chunk)
            //       // send chunk for render
            //       render_chunk(board_chunk)
            //     }
            //   }
            // const board_handler = highlight_board(board_content)
            // if (last_board.handler?.container) {
            //   last_board.handler.dispose()
            //   scene.remove(last_board.handler.container)
            // }
            // if (board_handler) {
            //   last_board.handler = board_handler
            //   scene.add(board_handler.container)
            // }
            // remember bounds for later board removal
            last_board.bounds = board_chunks_container.boardBounds
            last_board.pos = view_center
          }
        }
        FLAGS.LOD_MODE === LOD_MODE.DYNAMIC &&
          terrain_viewer.setLod(camera.position, 50, camera.far)
      })

      aiter(abortable(setInterval(200, null))).reduce(async () => {
        voxelmap_viewer.setAdaptativeQuality({
          distanceThreshold: 75,
          cameraPosition: camera.getWorldPosition(new Vector3()),
        })
      })
    },
  }
}
