'use client';

import { useState, useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Loader2, Plus, Trash2, Zap } from 'lucide-react';

interface SwarmNode {
  id: number;
  nodeId: string;
  gpuModel: string;
  gpuMemoryGb: number;
  status: 'online' | 'offline' | 'training';
  createdAt: Date;
}

export default function SwarmTraining() {
  const [nodes, setNodes] = useState<SwarmNode[]>([]);
  const [gpuModel, setGpuModel] = useState("RTX 4090");
  const [gpuMemory, setGpuMemory] = useState(24);
  const [isRegistering, setIsRegistering] = useState(false);

  const statsQuery = trpc.swarm.getStats.useQuery();
  const nodesQuery = trpc.swarm.getNodes.useQuery();
  const registerNodeMutation = trpc.swarm.registerNode.useMutation();
  const updateStatusMutation = trpc.swarm.updateNodeStatus.useMutation();

  useEffect(() => {
    if (nodesQuery.data) {
      setNodes(nodesQuery.data as SwarmNode[]);
    }
  }, [nodesQuery.data]);

  const handleRegisterNode = async () => {
    setIsRegistering(true);
    try {
      await registerNodeMutation.mutateAsync({
        gpuModel,
        gpuMemoryGb: gpuMemory,
      });
      setGpuModel("RTX 4090");
      setGpuMemory(24);
      nodesQuery.refetch();
    } catch (e) {
      console.error("Failed to register node", e);
    }
    setIsRegistering(false);
  };

  const handleUpdateNodeStatus = async (nodeId: string, newStatus: 'online' | 'offline' | 'training') => {
    try {
      await updateStatusMutation.mutateAsync({
        nodeId,
        status: newStatus,
      });
      nodesQuery.refetch();
    } catch (e) {
      console.error("Failed to update node status", e);
    }
  };

  const gpuHours = statsQuery.data?.gpuHoursContributed || 0;
  const killTokens = statsQuery.data?.killTokensEarned || 0;

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-6">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-5xl font-black tracking-tighter mb-2 text-red-600">SWARM TRAINING</h1>
          <p className="text-lg text-zinc-400">Decentralized GPU network. Contribute compute, earn $KILL tokens.</p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-3 gap-6 mb-12">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
            <p className="text-sm font-bold text-zinc-400 mb-2">GPU HOURS CONTRIBUTED</p>
            <p className="text-4xl font-black text-red-600">{gpuHours.toFixed(1)}</p>
            <p className="text-xs text-zinc-500 mt-2">Total compute hours</p>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
            <p className="text-sm font-bold text-zinc-400 mb-2">$KILL TOKENS EARNED</p>
            <p className="text-4xl font-black text-green-600">${killTokens.toFixed(2)}</p>
            <p className="text-xs text-zinc-500 mt-2">Rewards for contribution</p>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
            <p className="text-sm font-bold text-zinc-400 mb-2">ACTIVE NODES</p>
            <p className="text-4xl font-black text-blue-600">{nodes.filter(n => n.status === 'online').length}</p>
            <p className="text-xs text-zinc-500 mt-2">Out of {nodes.length} total</p>
          </div>
        </div>

        {/* Register Node Section */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-12">
          <h2 className="text-2xl font-bold mb-6 text-red-600">Register New Node</h2>
          
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div>
              <label className="block text-sm font-bold text-zinc-300 mb-2">GPU Model</label>
              <select
                value={gpuModel}
                onChange={(e) => setGpuModel(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-white focus:border-red-600 outline-none"
              >
                <option>RTX 4090</option>
                <option>RTX 4080</option>
                <option>RTX 4070</option>
                <option>A100</option>
                <option>H100</option>
                <option>L40</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-bold text-zinc-300 mb-2">GPU Memory (GB)</label>
              <input
                type="number"
                value={gpuMemory}
                onChange={(e) => setGpuMemory(parseInt(e.target.value))}
                min="1"
                max="192"
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-white focus:border-red-600 outline-none"
              />
            </div>

            <div className="flex items-end">
              <Button
                onClick={handleRegisterNode}
                disabled={isRegistering}
                className="w-full bg-red-600 hover:bg-red-700 font-bold"
              >
                {isRegistering ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="animate-spin" size={16} />
                    Registering...
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    <Plus size={16} />
                    Register Node
                  </span>
                )}
              </Button>
            </div>
          </div>
        </div>

        {/* Nodes List */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
          <h2 className="text-2xl font-bold mb-6 text-red-600">Your Nodes ({nodes.length})</h2>

          {nodes.length === 0 ? (
            <p className="text-zinc-400">No nodes registered yet. Register your first GPU node above.</p>
          ) : (
            <div className="space-y-4">
              {nodes.map(node => (
                <div
                  key={node.id}
                  className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 flex items-center justify-between"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <Zap
                        size={20}
                        className={
                          node.status === 'online'
                            ? 'text-green-600'
                            : node.status === 'training'
                            ? 'text-blue-600'
                            : 'text-zinc-500'
                        }
                      />
                      <p className="font-bold">{node.nodeId}</p>
                      <span
                        className={`text-xs font-bold px-2 py-1 rounded ${
                          node.status === 'online'
                            ? 'bg-green-600 bg-opacity-20 text-green-600'
                            : node.status === 'training'
                            ? 'bg-blue-600 bg-opacity-20 text-blue-600'
                            : 'bg-zinc-600 bg-opacity-20 text-zinc-400'
                        }`}
                      >
                        {node.status.toUpperCase()}
                      </span>
                    </div>
                    <p className="text-sm text-zinc-400">
                      {node.gpuModel} • {node.gpuMemoryGb}GB VRAM
                    </p>
                  </div>

                  <div className="flex gap-2">
                    <select
                      value={node.status}
                      onChange={(e) => handleUpdateNodeStatus(node.nodeId, e.target.value as 'online' | 'offline' | 'training')}
                      className="bg-zinc-700 border border-zinc-600 rounded px-2 py-1 text-sm text-white focus:border-red-600 outline-none"
                    >
                      <option value="online">Online</option>
                      <option value="offline">Offline</option>
                      <option value="training">Training</option>
                    </select>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Info Section */}
        <div className="mt-12 bg-zinc-900 border border-zinc-800 rounded-xl p-6">
          <h3 className="text-lg font-bold mb-4 text-red-600">Decentralized Training Network</h3>
          <ul className="space-y-2 text-sm text-zinc-400">
            <li>• Register GPU nodes to join the Killuma swarm</li>
            <li>• Earn $KILL tokens based on GPU hours contributed</li>
            <li>• Help train custom LoRAs and base models</li>
            <li>• Rewards distributed daily based on contribution</li>
            <li>• Run training jobs on your nodes for additional rewards</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
