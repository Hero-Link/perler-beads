import React, { useRef, useEffect, useCallback, useState } from 'react';
import { MappedPixel } from '../utils/pixelation';

interface FocusCanvasProps {
  mappedPixelData: MappedPixel[][];
  gridDimensions: { N: number; M: number };
  currentColor: string;
  completedCells: Set<string>;
  recommendedCell: { row: number; col: number } | null;
  recommendedRegion: { row: number; col: number }[] | null;
  canvasScale: number;
  canvasOffset: { x: number; y: number };
  gridSectionInterval: number;
  showSectionLines: boolean;
  sectionLineColor: string;
  isMirrorMode: boolean;
  onCellClick: (row: number, col: number) => void;
  onScaleChange: (scale: number) => void;
  onOffsetChange: (offset: { x: number; y: number }) => void;
}

const FocusCanvas: React.FC<FocusCanvasProps> = ({
  mappedPixelData,
  gridDimensions,
  currentColor,
  completedCells,
  recommendedCell,
  recommendedRegion,
  canvasScale,
  canvasOffset,
  gridSectionInterval,
  showSectionLines,
  sectionLineColor,
  isMirrorMode,
  onCellClick,
  onScaleChange,
  onOffsetChange
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [lastPanPoint, setLastPanPoint] = useState<{ x: number; y: number } | null>(null);
  const [lastPinchDistance, setLastPinchDistance] = useState<number | null>(null);
  const [blinkDim, setBlinkDim] = useState(0);
  const blinkRafRef = useRef<number | null>(null);

  // 当前颜色渐变闪烁：黑色遮罩 0 ↔ 0.3 平滑过渡
  useEffect(() => {
    let running = true;
    const startTime = Date.now();

    const animate = () => {
      if (!running) return;
      // sin 波：0 (亮) ↔ 0.3 (暗)，周期约1.5秒，所有颜色闪烁一致
      const t = (Date.now() - startTime) * 0.004;
      const dim = Math.round((0.15 + 0.15 * Math.sin(t)) * 100) / 100;
      setBlinkDim(dim);
      blinkRafRef.current = requestAnimationFrame(animate);
    };

    blinkRafRef.current = requestAnimationFrame(animate);
    return () => {
      running = false;
      if (blinkRafRef.current !== null) {
        cancelAnimationFrame(blinkRafRef.current);
      }
    };
  }, []);

  // 计算格子大小
  const cellSize = Math.max(15, Math.min(40, 300 / Math.max(gridDimensions.N, gridDimensions.M)));

  // 渲染画布
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !mappedPixelData) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 设置画布尺寸
    const canvasWidth = gridDimensions.N * cellSize;
    const canvasHeight = gridDimensions.M * cellSize;
    
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;

    // 清空画布
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    // 根据当前颜色的亮度选择闪烁遮罩：亮色用黑遮罩，暗色用白遮罩
    const curHex = currentColor.replace('#', '');
    const curR = parseInt(curHex.substr(0, 2), 16);
    const curG = parseInt(curHex.substr(2, 2), 16);
    const curB = parseInt(curHex.substr(4, 2), 16);
    const luminance = 0.299 * curR + 0.587 * curG + 0.114 * curB;
    const blinkOverlay = luminance > 128 ? `rgba(0, 0, 0, ${blinkDim})` : `rgba(255, 255, 255, ${blinkDim})`;
    const blinkOverlaySubtle = luminance > 128 ? `rgba(0, 0, 0, ${blinkDim / 3})` : `rgba(255, 255, 255, ${blinkDim / 3})`;

    // 渲染每个格子
    for (let row = 0; row < gridDimensions.M; row++) {
      for (let col = 0; col < gridDimensions.N; col++) {
        const pixel = mappedPixelData[row][col];
        const x = col * cellSize;
        const y = row * cellSize;
        const cellKey = `${row},${col}`;

        // 绘制格子
        if (pixel.color === currentColor && !completedCells.has(cellKey)) {
          // 将要拼的当前颜色未完成：原色 + 遮罩闪烁
          ctx.fillStyle = pixel.color;
          ctx.fillRect(x, y, cellSize, cellSize);
          ctx.fillStyle = blinkOverlay;
          ctx.fillRect(x, y, cellSize, cellSize);
        } else if (pixel.color === currentColor && completedCells.has(cellKey)) {
          // 当前颜色已拼完：原色 + 小幅闪烁 + 反色边框 + 斜线
          ctx.fillStyle = pixel.color;
          ctx.fillRect(x, y, cellSize, cellSize);
          ctx.fillStyle = blinkOverlaySubtle;
          ctx.fillRect(x, y, cellSize, cellSize);
          // 边框和斜线：亮色用黑，暗色用白
          ctx.strokeStyle = luminance > 128 ? '#000' : '#fff';
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + cellSize, y + cellSize);
          ctx.stroke();
        } else if (completedCells.has(cellKey)) {
          // 其他颜色已拼完：保持原色，无遮罩
          ctx.fillStyle = pixel.color;
          ctx.fillRect(x, y, cellSize, cellSize);
        } else {
          // 其他未拼颜色：先转灰度，再加灰色遮罩
          const hex = pixel.color.replace('#', '');
          const r = parseInt(hex.substr(0, 2), 16);
          const g = parseInt(hex.substr(2, 2), 16);
          const b = parseInt(hex.substr(4, 2), 16);
          const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
          ctx.fillStyle = `rgb(${gray}, ${gray}, ${gray})`;
          ctx.fillRect(x, y, cellSize, cellSize);
          ctx.fillStyle = 'rgba(128, 128, 128, 0.5)';
          ctx.fillRect(x, y, cellSize, cellSize);
        }

        // 如果是推荐区域的一部分，添加高亮边框
        const isInRecommendedRegion = recommendedRegion?.some(cell => 
          cell.row === row && cell.col === col
        );
        if (isInRecommendedRegion) {
          ctx.strokeStyle = '#ff4444';
          ctx.lineWidth = 3;
          ctx.setLineDash([5, 5]);
          ctx.strokeRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
          ctx.setLineDash([]);
        }
        
        // 如果是推荐区域的中心点，添加特殊标记
        if (recommendedCell && recommendedCell.row === row && recommendedCell.col === col && isInRecommendedRegion) {
          // 绘制中心点标记
          ctx.fillStyle = '#ff4444';
          ctx.beginPath();
          ctx.arc(x + cellSize / 2, y + cellSize / 2, 4, 0, 2 * Math.PI);
          ctx.fill();
        }




      }
    }

    // 镜像模式：将渲染好的画布水平翻转（先镜像格子，再画分区线，避免分割线被镜像）
    if (isMirrorMode) {
      const offscreen = document.createElement('canvas');
      offscreen.width = canvasWidth;
      offscreen.height = canvasHeight;
      const offCtx = offscreen.getContext('2d')!;
      offCtx.drawImage(canvas, 0, 0);
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(offscreen, -canvasWidth, 0);
      ctx.restore();
    }

    // 绘制分区线（在镜像之后绘制，保持分割线不被镜像）
    if (showSectionLines) {
      // 小分割线：每格一条，更细更透明
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
      ctx.lineWidth = 0.5;

      for (let col = 1; col < gridDimensions.N; col++) {
        const x = col * cellSize;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvasHeight);
        ctx.stroke();
      }

      for (let row = 1; row < gridDimensions.M; row++) {
        const y = row * cellSize;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvasWidth, y);
        ctx.stroke();
      }

      // 中分割线：每5格一条，颜色与大分割线一致，线宽减半
      ctx.strokeStyle = sectionLineColor;
      ctx.lineWidth = 1;

      for (let col = 5; col < gridDimensions.N; col += 5) {
        if (col % gridSectionInterval === 0) continue;
        const x = col * cellSize;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvasHeight);
        ctx.stroke();
      }

      for (let row = 5; row < gridDimensions.M; row += 5) {
        if (row % gridSectionInterval === 0) continue;
        const y = row * cellSize;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvasWidth, y);
        ctx.stroke();
      }

      // 大分割线：每 gridSectionInterval 格一条
      ctx.strokeStyle = sectionLineColor;
      ctx.lineWidth = 2;

      for (let col = gridSectionInterval; col < gridDimensions.N; col += gridSectionInterval) {
        const x = col * cellSize;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvasHeight);
        ctx.stroke();
      }

      for (let row = gridSectionInterval; row < gridDimensions.M; row += gridSectionInterval) {
        const y = row * cellSize;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvasWidth, y);
        ctx.stroke();
      }
    }
  }, [mappedPixelData, gridDimensions, cellSize, currentColor, completedCells, recommendedCell, recommendedRegion, gridSectionInterval, showSectionLines, sectionLineColor, isMirrorMode, blinkDim]);

  // 处理触摸/鼠标事件
  const getEventPosition = useCallback((event: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    let clientX: number, clientY: number;

    if ('touches' in event) {
      if (event.touches.length === 0) return null;
      clientX = event.touches[0].clientX;
      clientY = event.touches[0].clientY;
    } else {
      clientX = event.clientX;
      clientY = event.clientY;
    }

    return {
      x: (clientX - rect.left) / canvasScale,
      y: (clientY - rect.top) / canvasScale
    };
  }, [canvasScale]);

  const getGridPosition = useCallback((x: number, y: number) => {
    const visualCol = Math.floor(x / cellSize);
    const col = isMirrorMode ? (gridDimensions.N - 1 - visualCol) : visualCol;
    const row = Math.floor(y / cellSize);

    if (row >= 0 && row < gridDimensions.M && col >= 0 && col < gridDimensions.N) {
      return { row, col };
    }
    return null;
  }, [cellSize, gridDimensions, isMirrorMode]);

  // 计算两指间距离
  const getTouchDistance = (touches: React.TouchList) => {
    if (touches.length < 2) return 0;
    const touch1 = touches[0];
    const touch2 = touches[1];
    const dx = touch1.clientX - touch2.clientX;
    const dy = touch1.clientY - touch2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // 处理点击
  const handleClick = useCallback((event: React.MouseEvent | React.TouchEvent) => {
    event.preventDefault();
    
    const pos = getEventPosition(event);
    if (!pos) return;

    const gridPos = getGridPosition(pos.x, pos.y);
    if (gridPos) {
      onCellClick(gridPos.row, gridPos.col);
    }
  }, [onCellClick, getEventPosition, getGridPosition]);

  // 处理缩放
  const handleWheel = useCallback((event: React.WheelEvent) => {
    event.preventDefault();
    
    const delta = event.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.3, Math.min(3, canvasScale * delta));
    onScaleChange(newScale);
  }, [canvasScale, onScaleChange]);

  // 处理双指缩放（触摸）
  const handleTouchStart = useCallback((event: React.TouchEvent) => {
    if (event.touches.length === 1) {
      // 单指拖拽开始
      setIsDragging(true);
      setLastPanPoint({
        x: event.touches[0].clientX,
        y: event.touches[0].clientY
      });
      setLastPinchDistance(null);
    } else if (event.touches.length === 2) {
      // 双指缩放开始
      event.preventDefault();
      setIsDragging(false);
      setLastPanPoint(null);
      setLastPinchDistance(getTouchDistance(event.touches));
    }
  }, []);

  const handleTouchMove = useCallback((event: React.TouchEvent) => {
    event.preventDefault();
    
    if (event.touches.length === 1 && isDragging && lastPanPoint) {
      // 单指拖拽
      const deltaX = event.touches[0].clientX - lastPanPoint.x;
      const deltaY = event.touches[0].clientY - lastPanPoint.y;
      
      onOffsetChange({
        x: canvasOffset.x + deltaX,
        y: canvasOffset.y + deltaY
      });
      
      setLastPanPoint({
        x: event.touches[0].clientX,
        y: event.touches[0].clientY
      });
    } else if (event.touches.length === 2 && lastPinchDistance !== null) {
      // 双指缩放处理
      const currentDistance = getTouchDistance(event.touches);
      const scaleRatio = currentDistance / lastPinchDistance;
      
      // 限制缩放范围并应用缩放
      const newScale = Math.max(0.3, Math.min(3, canvasScale * scaleRatio));
      onScaleChange(newScale);
      
      // 更新距离记录
      setLastPinchDistance(currentDistance);
    }
  }, [isDragging, lastPanPoint, canvasOffset, onOffsetChange, lastPinchDistance, canvasScale, onScaleChange]);

  const handleTouchEnd = useCallback((event: React.TouchEvent) => {
    if (event.touches.length === 0) {
      setIsDragging(false);
      setLastPanPoint(null);
      setLastPinchDistance(null);
      
      // 如果没有移动太多，视为点击
      if (!isDragging) {
        handleClick(event);
      }
    } else if (event.touches.length === 1) {
      // 从双指缩放切换到单指拖拽
      setLastPinchDistance(null);
      setIsDragging(true);
      setLastPanPoint({
        x: event.touches[0].clientX,
        y: event.touches[0].clientY
      });
    }
  }, [isDragging, handleClick]);

  // 鼠标拖拽处理
  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    setIsDragging(true);
    setLastPanPoint({
      x: event.clientX,
      y: event.clientY
    });
  }, []);

  const handleMouseMove = useCallback((event: React.MouseEvent) => {
    if (isDragging && lastPanPoint) {
      const deltaX = event.clientX - lastPanPoint.x;
      const deltaY = event.clientY - lastPanPoint.y;
      
      onOffsetChange({
        x: canvasOffset.x + deltaX,
        y: canvasOffset.y + deltaY
      });
      
      setLastPanPoint({
        x: event.clientX,
        y: event.clientY
      });
    }
  }, [isDragging, lastPanPoint, canvasOffset, onOffsetChange]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setLastPanPoint(null);
  }, []);

  // 渲染画布
  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  return (
    <div 
      ref={containerRef}
      className="w-full h-full flex items-center justify-center overflow-hidden bg-gray-100"
      style={{ touchAction: 'none' }}
    >
      <div
        style={{
          transform: `scale(${canvasScale}) translate(${canvasOffset.x}px, ${canvasOffset.y}px)`,
          transformOrigin: 'center center'
        }}
      >
        <canvas
          ref={canvasRef}
          className="cursor-crosshair border border-gray-300"
          onClick={handleClick}
          onWheel={handleWheel}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        />
      </div>
    </div>
  );
};

export default FocusCanvas;