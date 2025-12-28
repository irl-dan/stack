import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import type { TreeNode } from '../types/flame';
import { getStatusColor } from '../data/flameApi';

interface FlameTreeProps {
  data: TreeNode[];
  width?: number;
  height?: number;
  onNodeClick?: (node: TreeNode) => void;
}

export function FlameTree({
  data,
  width = 1200,
  height = 800,
  onNodeClick,
}: FlameTreeProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || data.length === 0) return;

    // Clear previous content
    d3.select(svgRef.current).selectAll('*').remove();

    // Create a virtual root to hold multiple trees
    const virtualRoot: TreeNode = {
      id: '__root__',
      goal: 'Flame Trees',
      status: 'in_progress',
      isActive: false,
      children: data,
      // Required fields (not used for virtual root)
      createdAt: Date.now(),
      updatedAt: Date.now(),
      artifacts: [],
      decisions: [],
    };

    // Create hierarchy
    const root = d3.hierarchy(virtualRoot);

    // Calculate tree layout
    const treeLayout = d3.tree<TreeNode>()
      .size([height - 100, width - 300])
      .separation((a, b) => (a.parent === b.parent ? 1.5 : 2));

    const treeData = treeLayout(root);

    // Create SVG group with margin
    const svg = d3.select(svgRef.current);
    const g = svg
      .append('g')
      .attr('transform', `translate(150, 50)`);

    // Draw links (edges)
    g.selectAll('.link')
      .data(treeData.links().filter(d => d.source.data.id !== '__root__'))
      .join('path')
      .attr('class', 'link')
      .attr('fill', 'none')
      .attr('stroke', '#94a3b8')
      .attr('stroke-width', 2)
      .attr('d', d3.linkHorizontal<d3.HierarchyPointLink<TreeNode>, d3.HierarchyPointNode<TreeNode>>()
        .x(d => d.y)
        .y(d => d.x)
      );

    // Draw dashed links from virtual root to real roots
    g.selectAll('.root-link')
      .data(treeData.links().filter(d => d.source.data.id === '__root__'))
      .join('path')
      .attr('class', 'root-link')
      .attr('fill', 'none')
      .attr('stroke', '#cbd5e1')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '4,4')
      .attr('d', d3.linkHorizontal<d3.HierarchyPointLink<TreeNode>, d3.HierarchyPointNode<TreeNode>>()
        .x(d => d.y)
        .y(d => d.x)
      );

    // Filter out virtual root from nodes
    const realNodes = treeData.descendants().filter(d => d.data.id !== '__root__');

    // Draw nodes
    const nodeGroup = g.selectAll('.node')
      .data(realNodes)
      .join('g')
      .attr('class', 'node')
      .attr('transform', d => `translate(${d.y}, ${d.x})`)
      .style('cursor', 'pointer')
      .on('click', (event, d) => {
        event.stopPropagation();
        onNodeClick?.(d.data);
      });

    // Node circles
    nodeGroup.append('circle')
      .attr('r', d => d.data.isActive ? 14 : 10)
      .attr('fill', d => getStatusColor(d.data.status))
      .attr('stroke', d => d.data.isActive ? '#fbbf24' : '#fff')
      .attr('stroke-width', d => d.data.isActive ? 4 : 2)
      .attr('filter', d => d.data.isActive ? 'drop-shadow(0 0 6px rgba(251, 191, 36, 0.6))' : 'none');

    // Active indicator ring
    nodeGroup.filter(d => d.data.isActive)
      .append('circle')
      .attr('r', 20)
      .attr('fill', 'none')
      .attr('stroke', '#fbbf24')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '3,3')
      .attr('opacity', 0.7);

    // Goal labels
    nodeGroup.append('text')
      .attr('dy', '0.31em')
      .attr('x', d => d.children ? -16 : 16)
      .attr('text-anchor', d => d.children ? 'end' : 'start')
      .attr('font-size', '12px')
      .attr('fill', '#374151')
      .text(d => truncateText(d.data.goal, 40));

    // Status labels (small, below the goal)
    nodeGroup.append('text')
      .attr('dy', '1.5em')
      .attr('x', d => d.children ? -16 : 16)
      .attr('text-anchor', d => d.children ? 'end' : 'start')
      .attr('font-size', '10px')
      .attr('fill', d => getStatusColor(d.data.status))
      .attr('font-weight', '500')
      .text(d => d.data.status.replace('_', ' '));

    // Add zoom behavior
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 3])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });

    svg.call(zoom);

    // Initial transform
    svg.call(zoom.transform, d3.zoomIdentity.translate(150, 50));

  }, [data, width, height, onNodeClick]);

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      style={{
        backgroundColor: '#f8fafc',
        borderRadius: '8px',
        border: '1px solid #e2e8f0'
      }}
    />
  );
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}
