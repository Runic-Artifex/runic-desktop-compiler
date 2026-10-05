<script lang="ts" module>
  import { getContext, setContext } from 'svelte';
  import type { SingleGroup, MultipleGroup } from './group.svelte.ts';

  interface GroupContext {
    group?: SingleGroup | MultipleGroup;
    tone?: 'plain' | 'loud';
  }

  export function setGroupCtx(ctx: GroupContext) {
    setContext('group', ctx);
  }

  export function getGroupCtx() {
    return getContext<Required<GroupContext>>('group');
  }
</script>

<script lang="ts">
  // A component whose props are a discriminated union (bits-ui's
  // ToggleGroup.Root): every site passes type "multiple", so value is a
  // string array. Its context is an object of getters.
  import type { Snippet } from 'svelte';
  import { boxWith, type WritableBox } from 'svelte-toolbelt';
  import { createGroup } from './group.svelte.ts';

  type Props = (
    | { type: 'single'; value?: string; onValueChange?: (v: string) => void }
    | { type: 'multiple'; value?: string[]; onValueChange?: (v: string[]) => void }
  ) & { name: string; tone?: 'plain' | 'loud'; loop?: boolean; children?: Snippet };

  let {
    type,
    value = $bindable(),
    onValueChange = () => {},
    name,
    tone = 'plain',
    loop = true,
    children,
  }: Props = $props();

  if (value === undefined) value = type === 'single' ? '' : [];

  const group = createGroup({
    type,
    value: boxWith(
      () => value!,
      v => {
        value = v;
        // @ts-expect-error - the type decides the value's type
        onValueChange(v);
      },
    ) as WritableBox<string> | WritableBox<string[]>,
    name: boxWith(() => name),
    loop: boxWith(() => loop),
  });

  setGroupCtx({
    get group() {
      return group;
    },
    get tone() {
      return tone;
    },
  });
</script>

<div class="list" role="group" data-tone={tone} aria-label={group.label}>
  {@render children?.()}
  <span id="{name}-any">{group.anyPressed ? 'some' : 'none'}</span>
</div>
