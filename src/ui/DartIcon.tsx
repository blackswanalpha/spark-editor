import { forwardRef, type SVGProps } from "react";
import type { IconWeight } from "@phosphor-icons/react";

type DartIconProps = Omit<SVGProps<SVGSVGElement>, "weight"> & {
  size?: number | string;
  weight?: IconWeight;
  color?: string;
  className?: string;
};

export const DartIcon = forwardRef<SVGSVGElement, DartIconProps>(function DartIcon(
  {
    size = 24,
    weight: _weight = "regular",
    color: _color = "currentColor",
    className,
    ...rest
  },
  ref,
) {
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={["icon", className].filter(Boolean).join(" ")}
      aria-hidden
      {...rest}
    >
      <path
        d="M2 14.5L9 21.5L19.5 11L14.5 6L2 14.5Z"
        fill="currentColor"
      />
      <path
        d="M14.5 2L9 7.5L14.5 13L19.5 8L14.5 2Z"
        fill="currentColor"
        opacity="0.6"
      />
      <path
        d="M14.5 2L19.5 7L21 5.5L21 2L14.5 2Z"
        fill="currentColor"
        opacity="0.4"
      />
    </svg>
  );
});

export default DartIcon;
