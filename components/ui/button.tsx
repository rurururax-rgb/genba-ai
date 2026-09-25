import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  // base: focus ring uses --ring which is RAGZ green from globals.css
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[8px] text-sm font-semibold transition-colors duration-[120ms] ease-[cubic-bezier(0.4,0,0.2,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // ── RAGZ variants ────────────────────────────────────────
        // Primary: RAGZ brand green — the main next action
        primary:
          "bg-[#2B5E40] text-white hover:bg-[#3D7A55] active:bg-[#1D4530] disabled:bg-[#9BBFA7] disabled:text-white disabled:cursor-not-allowed",
        // Secondary: white/border — clear but not dominant
        secondary:
          "bg-white text-[#1A2E24] border border-[#C0D4C5] hover:bg-[#F3F7F4] active:bg-[#E8F2EB] disabled:bg-[#F3F4F6] disabled:text-[#9CA3AF] disabled:border-[#E4E8EE] disabled:cursor-not-allowed",
        // Tertiary: ghost-like — supplementary actions
        tertiary:
          "bg-transparent text-[#4B7560] hover:bg-[rgba(61,122,85,0.08)] active:bg-[rgba(61,122,85,0.14)] disabled:text-[#9BBFA7] disabled:cursor-not-allowed",
        // Danger: delete/destroy only
        danger:
          "bg-[#FEF2F2] text-[#DC2626] border border-[#FCA5A5] hover:bg-[#FEE2E2] active:bg-[#FECACA] disabled:bg-[#FEF2F2] disabled:text-[#FCA5A5] disabled:border-[#FECACA] disabled:cursor-not-allowed",
        // ── Legacy shadcn variants (keep for backward compat) ───
        default:
          "bg-[#2B5E40] text-white hover:bg-[#3D7A55] active:bg-[#1D4530] disabled:bg-[#9BBFA7] disabled:text-white disabled:cursor-not-allowed",
        destructive:
          "bg-[#FEF2F2] text-[#DC2626] border border-[#FCA5A5] hover:bg-[#FEE2E2] disabled:bg-[#FEF2F2] disabled:text-[#FCA5A5] disabled:border-[#FECACA] disabled:cursor-not-allowed",
        outline:
          "bg-white text-[#1A2E24] border border-[#C0D4C5] hover:bg-[#F3F7F4] disabled:bg-[#F3F4F6] disabled:text-[#9CA3AF] disabled:border-[#E4E8EE] disabled:cursor-not-allowed",
        ghost:
          "bg-transparent text-[#4B7560] hover:bg-[rgba(61,122,85,0.08)] disabled:text-[#9BBFA7] disabled:cursor-not-allowed",
        link: "text-[#3D7A55] underline-offset-4 hover:underline disabled:text-[#9CA3AF] disabled:no-underline",
      },
      size: {
        // Small: dense UIs (table rows, toolbars, cards)
        sm: "h-9 px-3 text-xs [&_svg]:size-4",
        // Medium: standard (default for most screens)
        default: "h-11 px-4 [&_svg]:size-[18px]",
        // Large: CTAs, mobile, important actions
        lg: "h-12 px-5 text-base [&_svg]:size-5",
        // Icon: square icon-only buttons
        icon: "h-9 w-9 [&_svg]:size-[18px]",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
