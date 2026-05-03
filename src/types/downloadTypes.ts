// 下载网格的选项类型定义
export type GridDownloadOptions = {
  showGrid: boolean;
  gridInterval: number;
  showCoordinates: boolean;
  showCellNumbers: boolean;
  gridLineColor: string;
  includeStats: boolean;
  exportCsv: boolean; // 新增：是否同时导出CSV hex数据
  sortByKey: boolean; // 新增：是否按色号字母数字顺序排序
};
