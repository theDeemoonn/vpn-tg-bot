import React, { useEffect, useState } from 'react';
import axios from 'axios';

interface Setting {
  id: number;
  key: string;
  value: string;
  description: string;
}

const Settings: React.FC = () => {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [editedSettings, setEditedSettings] = useState<{[key: string]: string}>({});
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        setIsLoading(true);
        const response = await axios.get('/api/settings');
        setSettings(response.data.settings);
        
        // Инициализируем состояние редактирования
        const initialEditState: {[key: string]: string} = {};
        response.data.settings.forEach((setting: Setting) => {
          initialEditState[setting.key] = setting.value;
        });
        
        setEditedSettings(initialEditState);
        setError(null);
      } catch (err: any) {
        setError('Ошибка при загрузке настроек: ' + (err.response?.data?.message || err.message));
      } finally {
        setIsLoading(false);
      }
    };

    fetchSettings();
  }, []);

  const handleInputChange = (key: string, value: string) => {
    setEditedSettings({
      ...editedSettings,
      [key]: value
    });
  };

  const handleSaveSettings = async () => {
    try {
      setIsSaving(true);
      setError(null);
      setSuccessMessage(null);
      
      // Формируем массив настроек для обновления
      const updatedSettings = Object.keys(editedSettings).map(key => ({
        key,
        value: editedSettings[key]
      }));
      
      await axios.put('/api/settings/bulk', { settings: updatedSettings });
      
      setSuccessMessage('Настройки успешно сохранены');
      
      // Обновляем локальное состояние настроек
      setSettings(settings.map(setting => ({
        ...setting,
        value: editedSettings[setting.key] || setting.value
      })));
      
    } catch (err: any) {
      setError('Ошибка при сохранении настроек: ' + (err.response?.data?.message || err.message));
    } finally {
      setIsSaving(false);
      
      // Автоматически скрываем сообщение об успехе через 3 секунды
      if (successMessage) {
        setTimeout(() => setSuccessMessage(null), 3000);
      }
    }
  };

  if (isLoading) {
    return <div className="loading">Загрузка настроек...</div>;
  }

  return (
    <div className="settings-page">
      <h1 className="page-title">Настройки системы</h1>
      
      {error && <div className="error-message">{error}</div>}
      {successMessage && <div className="success-message">{successMessage}</div>}
      
      <div className="card">
        <div className="settings-form">
          {settings.map(setting => (
            <div className="form-group" key={setting.id}>
              <label htmlFor={`setting-${setting.key}`}>
                {setting.description || setting.key}
              </label>
              <input
                type={setting.key.includes('PASSWORD') ? 'password' : 'text'}
                id={`setting-${setting.key}`}
                value={editedSettings[setting.key] || ''}
                onChange={(e) => handleInputChange(setting.key, e.target.value)}
              />
            </div>
          ))}
          
          <div className="form-actions">
            <button 
              className="btn btn-primary" 
              onClick={handleSaveSettings}
              disabled={isSaving}
            >
              {isSaving ? 'Сохранение...' : 'Сохранить настройки'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings; 