import { FLOOR_HEIGHT } from '../office3d-layout.ts'

/** The floor tab name for a level, by its height: the stock levels keep their names whatever else the scene adds. */
export function levelName(height: number, index: number): { label: string; title: string } {
  if (height === 0) return { label: 'Kantor', title: 'Lantai 1: office, lounge, pantry and game room' }
  if (height === FLOOR_HEIGHT) return { label: 'Kamar & Balkon', title: 'Lantai 2: bedroom, lesehan and balcony' }
  return { label: `Lantai ${index + 1}`, title: `Lantai ${index + 1}` }
}
