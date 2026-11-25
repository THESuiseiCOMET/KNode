import type { InjectionKey } from 'vue'
import type { ProjectDocument, ForestNode } from '../domain/model'
export interface CardUI {
  page: 'files' | 'properties' | null
  order?: number
}
export interface CardServices {
  readonly token: string
  readonly project: ProjectDocument | null
  readonly locked: boolean
  ui(id: string): CardUI
  bringForward(id: string): void
  prepare(): Promise<void>
  operation<T>(task: () => Promise<T>): Promise<T>
  attribute(id: string, patch: Partial<Pick<ForestNode, 'title' | 'weight'>>): void
  links(id: string, paths: string[]): void
  previewColor(id: string, color: string): void
  commitColor(id: string, color: string): void
  cancelColor(): void
}
export const cardServices: InjectionKey<CardServices> = Symbol('forest-card-services')
