import { on } from 'events'

import { aiter } from 'iterator-helper'

/** @type {Type.Module} */
export default function () {
  return {
    reduce(state, { type, payload }) {
      if (type === 'action/keydown' || type === 'action/keyup') {
        const enabled = type === 'action/keydown'
        const { inputs, settings } = state
        const key_role = settings.keymap.get(payload)

        if (key_role) inputs[key_role] = enabled

        return {
          ...state,
          inputs,
        }
      } else if (type === 'action/mousedown' || type === 'action/mouseup') {
        const button = payload
        const { inputs } = state
        const enabled = type === 'action/mousedown'
        if (button === 0) {
          inputs.mouse_left = enabled
        } else if (button === 2) {
          inputs.mouse_right = enabled
        }

        return {
          ...state,
          inputs,
        }
      } else if (type === 'action/window_focus') {
        const lost_focus = !payload
        if (lost_focus) {
          const { inputs } = state
          inputs.mouse_left = false
          inputs.mouse_right = false
          inputs.forward = false
          inputs.backward = false
          inputs.left = false
          inputs.right = false
          return {
            ...state,
            inputs,
          }
        }
      }
      return state
    },
    observe({ dispatch, signal }) {
      // @ts-ignore
      aiter(on(window, 'keydown', { signal })).forEach(([{ code }]) =>
        dispatch('action/keydown', code),
      )
      // @ts-ignore
      aiter(on(window, 'keyup', { signal })).forEach(([{ code }]) =>
        dispatch('action/keyup', code),
      )
      // @ts-ignore
      aiter(on(window, 'mouseup', { signal })).forEach(([{ button }]) =>
        dispatch('action/mouseup', button),
      )
      // @ts-ignore
      aiter(on(window, 'mousedown', { signal })).forEach(([{ button }]) =>
        dispatch('action/mousedown', button),
      )

      // @ts-ignore
      aiter(on(window, 'blur', { signal })).forEach(() =>
        dispatch('action/window_focus', false),
      )
    },
  }
}
