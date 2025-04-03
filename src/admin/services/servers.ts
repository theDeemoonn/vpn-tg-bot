import axios from 'axios';

// Используем относительный путь для API, как в auth.ts
const API_URL = '/api';

export interface ServerDeploymentData {
  name: string;
  ip: string;
  sshUsername: string;
  sshPort: string;
  sshPassword?: string;
  location?: string;
  provider?: string;
}

export interface DeploymentStatus {
  status: 'pending' | 'installing_docker' | 'pulling_image' | 'creating_config' | 'starting_xray' | 'completed' | 'failed';
  serverId: number;
  logs: string;
  error?: string;
}

export const deployServer = async (data: ServerDeploymentData): Promise<{ deploymentId: string, serverId: number }> => {
  const payload = {
      ...data,
      sshPassword: data.sshPassword || undefined
  };
  const response = await axios.post(`${API_URL}/servers/deploy`, payload, {
       headers: { 'Authorization': `Bearer ${localStorage.getItem('adminToken')}` }
  });
  return response.data;
};

export const getDeploymentStatus = async (deploymentId: string): Promise<DeploymentStatus> => {
  const response = await axios.get(`${API_URL}/servers/deploy/${deploymentId}/status`, {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('adminToken')}` }
  });
  return response.data;
}; 