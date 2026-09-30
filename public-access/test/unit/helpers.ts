import { computePublished, EMPTY, type Published } from '../../src/policy/published.ts';
import type { Ctx } from '../../src/policy/filter.ts';

export const ctx: Ctx = { dashboardKey: 'public-test', dashboardUrlPath: 'public-test', viewPath: 'solar', title: 'Solar' };

export const VIEW = {
  path: 'solar',
  cards: [
    { type: 'entities', entities: ['sensor.temp', { entity: 'light.lamp' }] },
    { type: 'markdown', content: "It is {{ states('sensor.temp') }} out" },
    { type: 'custom:button-card', entity: 'sensor.other', state_display: "[[[ return states['sensor.js_ref'].state ]]]" },
  ],
};

export function published(over: Partial<Published> = {}): Published {
  return {
    ...computePublished({
      view: VIEW,
      registry: [
        { entity_id: 'sensor.temp', device_id: 'dev1', area_id: null },
        { entity_id: 'light.lamp', device_id: 'dev2', area_id: 'kitchen' },
        { entity_id: 'lock.secret', device_id: 'dev3', area_id: 'hall' },
      ],
      devices: [{ id: 'dev1', area_id: 'garden' }, { id: 'dev2' }, { id: 'dev3', area_id: 'hall' }],
      areas: [{ area_id: 'garden', floor_id: 'f1' }, { area_id: 'kitchen' }, { area_id: 'hall', floor_id: 'f2' }],
      floorIds: ['f1', 'f2'],
      labelIds: [],
    }),
    ...over,
  };
}
export { EMPTY };
