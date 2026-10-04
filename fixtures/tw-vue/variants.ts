// Variant functions in the shape of the editor's shadcn wrappers (base,
// variants, defaultVariants), plus a boolean variant and compound variants.
import { tv, type VariantProps } from 'tailwind-variants';

export const buttonVariants = tv({
  base: 'btn inline-flex rounded-md border px-4 py-2 text-sm',
  variants: {
    variant: {
      solid: 'bg-blue text-white border-blue',
      outline: 'bg-white text-blue border-blue',
      ghost: 'bg-transparent border-transparent px-2',
    },
    size: {
      sm: 'px-2 py-1 text-xs',
      md: '',
      lg: 'px-6 py-3 text-lg rounded-lg',
    },
  },
  defaultVariants: { variant: 'solid', size: 'md' },
});

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
export type ButtonSize = VariantProps<typeof buttonVariants>['size'];

export const badgeVariants = tv({
  base: 'badge rounded-full px-3 py-1 text-xs',
  variants: {
    active: { true: 'font-bold ring-2', false: 'font-normal' },
    tone: { warm: 'bg-warm text-dark', cool: 'bg-cool text-dark' },
  },
  compoundVariants: [{ active: true, tone: 'warm', class: 'ring-warm px-5' }],
  defaultVariants: { active: false },
});
