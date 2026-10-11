export const ROW = 24
export const LANE = 16
export const PAD = 14
export const PALETTE = ['#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#ff0000', '#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00']
export const GREY = '#808080'
export const color = (lane: number): string => PALETTE[lane % PALETTE.length]
