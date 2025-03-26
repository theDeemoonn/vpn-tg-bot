import axios from 'axios';

// Используем относительный путь для API, так как настроено проксирование в nginx
const API_URL = '/api';

// Добавляем перехватчик запросов для добавления токена аутентификации
axios.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/**
 * Вход в систему администратора
 * @param {string} username - Имя пользователя
 * @param {string} password - Пароль
 * @returns {Promise<any>} - Данные пользователя и токен
 */
export const login = async (username: string, password: string) => {
  try {
    const response = await axios.post(`${API_URL}/auth/login`, { username, password });
    const { token, user } = response.data;
    localStorage.setItem('token', token);
    return { token, user };
  } catch (error) {
    console.error('Ошибка при входе:', error);
    throw error;
  }
};

/**
 * Проверка статуса аутентификации
 * @returns {Promise<any>} - Данные пользователя, если аутентифицирован
 */
export const checkAuthStatus = async () => {
  return axios.get(`${API_URL}/auth/verify`);
};

/**
 * Выход из системы
 */
export const logout = () => {
  localStorage.removeItem('token');
  window.location.href = '/login';
}; 