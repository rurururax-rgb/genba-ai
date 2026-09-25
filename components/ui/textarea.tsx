import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const textareaVariants = cva(
  [
    "w-full rounded-[8px] border bg-white text-[#1A2E24] font-normal",
    "placeholder:text-[#8A9A91]",
    "transition-[border-color,box-shadow] duration-[120ms] ease-[cubic-bezier(0.4,0,0.2,1)]",
    "outline-none resize-vertical",
    // readonly — distinct from disabled
    "read-only:bg-[#F8FAF8] read-only:border-[#E4E8E5] read-only:text-[#47564E] read-only:cursor-default",
    "read-only:hover:border-[#E4E8E5]",
    // disabled — explicit colors, not opacity-only
    "disabled:bg-[#F3F4F6] disabled:border-[#E4E8EE] disabled:text-[#9CA3AF] disabled:cursor-not-allowed",
    "disabled:hover:border-[#E4E8EE]",
  ].join(" "),
  {
    variants: {
      inputSize: {
        compact: "min-h-[72px] px-3 py-2 text-sm leading-[1.5]",
        default: "min-h-[96px] px-3 py-[10px] text-[15px] leading-[22px]",
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

export interface TextareaProps
  extends React.ComponentProps<"textarea">,
    Omit<VariantProps<typeof textareaVariants>, "state"> {
  error?: boolean
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, inputSize, error, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        {...props}
        aria-invalid={error ? true : props["aria-invalid"]}
        className={cn(
          textareaVariants({ inputSize, state: error ? "error" : "default" }),
          className
        )}
      />
    )
  }
)
Textarea.displayName = "Textarea"

export { Textarea, textareaVariants }
