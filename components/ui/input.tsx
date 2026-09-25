import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const inputVariants = cva(
  [
    "w-full rounded-[8px] border bg-white text-[#1A2E24] font-normal",
    "placeholder:text-[#8A9A91]",
    "transition-[border-color,box-shadow] duration-[120ms] ease-[cubic-bezier(0.4,0,0.2,1)]",
    "outline-none",
    // readonly — distinct from disabled
    "read-only:bg-[#F8FAF8] read-only:border-[#E4E8E5] read-only:text-[#47564E] read-only:cursor-default",
    "read-only:hover:border-[#E4E8E5]",
    // disabled — explicit colors, not opacity-only
    "disabled:bg-[#F3F4F6] disabled:border-[#E4E8EE] disabled:text-[#9CA3AF] disabled:cursor-not-allowed",
    "disabled:hover:border-[#E4E8EE]",
    "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-[#1A2E24]",
  ].join(" "),
  {
    variants: {
      inputSize: {
        compact: "h-9 px-[10px] text-sm leading-5",
        default: "h-11 px-3 text-[15px] leading-5",
        large:   "h-12 px-[14px] text-base leading-5",
      },
      state: {
        default: [
          "border-[#D5DED8]",
          "hover:border-[#AFC4B5]",
          "focus:border-[#2B5E40]",
          "focus:shadow-[0_0_0_3px_rgba(43,94,64,0.14)]",
        ].join(" "),
        error: [
          "border-[#DC2626]",
          "hover:border-[#DC2626]",
          "focus:border-[#DC2626]",
          "focus:shadow-[0_0_0_3px_rgba(220,38,38,0.12)]",
        ].join(" "),
      },
    },
    defaultVariants: {
      inputSize: "default",
      state: "default",
    },
  }
)

export interface InputProps
  extends React.ComponentProps<"input">,
    Omit<VariantProps<typeof inputVariants>, "state"> {
  error?: boolean
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, inputSize, error, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        {...props}
        aria-invalid={error ? true : props["aria-invalid"]}
        className={cn(
          inputVariants({ inputSize, state: error ? "error" : "default" }),
          className
        )}
      />
    )
  }
)
Input.displayName = "Input"

export { Input, inputVariants }
