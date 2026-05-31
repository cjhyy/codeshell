import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

/**
 * Switch — track + thumb colors are driven by explicit CSS in tailwind.css
 * (`.cs-switch` / `.cs-switch-thumb` keyed on Radix's `data-state`), NOT by
 * Tailwind's `data-[state=checked]:` arbitrary variant. Tailwind v4.3 compiles
 * that variant by dropping the class prefix (emits a bare `[data-state=checked]`
 * rule), which both fails to color the switch and bleeds onto every other
 * `data-state="checked"` element. The explicit classes avoid that bug.
 */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "cs-switch peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb className="cs-switch-thumb pointer-events-none block h-4 w-4 rounded-full shadow-lg ring-0 transition-transform" />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
