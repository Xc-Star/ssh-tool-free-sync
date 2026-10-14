import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-45 select-none outline-none focus-visible:ring-2 focus-visible:ring-accent/60 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white hover:bg-accent-hover shadow-sm',
        secondary: 'bg-panel-hover text-fg hover:bg-line border border-line',
        outline: 'border border-line-strong text-fg hover:bg-panel-hover',
        ghost: 'text-muted hover:text-fg hover:bg-panel-hover',
        danger: 'bg-danger text-white hover:brightness-110',
        'danger-ghost': 'text-danger hover:bg-danger/10',
        link: 'text-accent hover:underline px-0 h-auto'
      },
      size: {
        xs: 'h-6 px-2 text-xs [&_svg]:size-3.5',
        sm: 'h-7 px-2.5 text-xs [&_svg]:size-3.5',
        md: 'h-8 px-3 text-[13px] [&_svg]:size-4',
        lg: 'h-10 px-5 text-sm [&_svg]:size-4',
        icon: 'size-8 [&_svg]:size-4',
        'icon-sm': 'size-7 [&_svg]:size-3.5',
        'icon-xs': 'size-6 [&_svg]:size-3.5'
      }
    },
    defaultVariants: { variant: 'secondary', size: 'md' }
  }
)

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, type, ...props }, ref) => {
  const Comp = asChild ? Slot.Root : 'button'
  return <Comp ref={ref} type={asChild ? undefined : (type ?? 'button')} className={cn(buttonVariants({ variant, size }), className)} {...props} />
})
Button.displayName = 'Button'
