import { type JSX, type JSXNode, jsx } from "@oh-my-pi/pi-tui";

export function node<K extends keyof JSX.IntrinsicElements>(
	kind: K,
	props: JSX.IntrinsicElements[K] & Parameters<typeof jsx>[1],
	key?: string,
): JSXNode {
	return jsx(kind, props, key);
}
