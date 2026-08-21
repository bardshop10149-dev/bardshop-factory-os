// 品項編碼字首對應的 BOM 規則——部分品項本來就不需要真正拆分的 BOM：
//
//   C 開頭：委外生產，本身不需要 BOM（沒有要在本廠領用的原料）
//   O 開頭／S 開頭：代工，原料由客戶提供，本身不需要 BOM
//   M 開頭／W 開頭：子件料號等於料號本身（自我參照，沒有真正拆分的 BOM），
//     例：MCOAA-RN-B 本身就是它自己的子件，備料時直接查這個料號的庫存即可
//
// 供「工序/BOM補登表」的缺BOM判斷、以及「批備料」頁面的實際庫存查核邏輯共用，
// 避免這條業務規則在兩個地方各自維護、日後漂移不一致。

export type BomPrefixRule = 'outsourced' | 'self_reference' | null

export function classifyBomPrefix(itemCode: string): BomPrefixRule {
  const prefix = itemCode.trim().charAt(0).toUpperCase()
  if (prefix === 'C' || prefix === 'O' || prefix === 'S') return 'outsourced'
  if (prefix === 'M' || prefix === 'W') return 'self_reference'
  return null
}
