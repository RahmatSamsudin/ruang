export type PovMode = 'first' | 'third'

export function agentCameraPose(
  mode: PovMode,
  pos: [number, number, number],
  facing: number,
  seated: boolean,
): { position: [number, number, number]; lookAt: [number, number, number] } {
  const forwardX = Math.sin(facing)
  const forwardZ = Math.cos(facing)

  if (mode === 'first') {
    const y = pos[1] + (seated ? 1.36 : 1.52)
    const position: [number, number, number] = [
      pos[0] + forwardX * 0.22,
      y,
      pos[2] + forwardZ * 0.22,
    ]
    const lookAt: [number, number, number] = [
      position[0] + forwardX * 5,
      y,
      position[2] + forwardZ * 5,
    ]
    return { position, lookAt }
  }

  const rightX = -Math.cos(facing)
  const rightZ = Math.sin(facing)

  const position: [number, number, number] = [
    pos[0] - forwardX * 2.2 + rightX * 0.35,
    pos[1] + 1.8,
    pos[2] - forwardZ * 2.2 + rightZ * 0.35,
  ]
  const lookAt: [number, number, number] = [
    pos[0] + forwardX * 5,
    pos[1] + 1.2,
    pos[2] + forwardZ * 5,
  ]
  return { position, lookAt }
}
