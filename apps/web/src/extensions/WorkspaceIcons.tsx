/* eslint-disable shadcn/no-raw-colors -- App icon artwork uses a fixed palette. */
import { useId, type SVGProps } from "react";

export function ChatIcon(props: SVGProps<SVGSVGElement>) {
  // useId can contain ":" or "«»"; keep url(#...) references plain.
  const id = useId().replace(/[^\w-]/g, "");
  return (
    <svg {...props} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient
          id={`${id}-color`}
          x1="0"
          y1="0"
          x2="24"
          y2="24"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#3B82F6" />
          <stop offset="1" stopColor="#4F46E5" />
        </linearGradient>
        <linearGradient
          id={`${id}-gloss`}
          x1="0"
          y1="0"
          x2="0"
          y2="24"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" stopOpacity=".24" />
          <stop offset=".55" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x=".5" y=".5" width="23" height="23" rx="5.2" fill={`url(#${id}-color)`} />
      <rect
        x=".5"
        y=".5"
        width="23"
        height="23"
        rx="5.2"
        fill={`url(#${id}-gloss)`}
        stroke="white"
        strokeOpacity=".22"
      />
      <path
        fill="white"
        d="M12 5.5c-4.1 0-7 2.6-7 6 0 1.4.5 2.6 1.4 3.6L5.8 18l3.3-1.4c.9.4 1.9.6 2.9.6 4.1 0 7-2.5 7-5.7s-2.9-6-7-6Z"
      />
    </svg>
  );
}
