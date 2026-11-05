export function pivotPoint({ open, high, close }) {
  return (open + high + close) / 3;
}

export const round = (value, decimals) => Number(value.toFixed(decimals));
