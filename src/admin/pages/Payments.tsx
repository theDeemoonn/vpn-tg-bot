import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';

interface Payment {
  id: number;
  userId: number;
  amount: number;
  status: string;
  paymentId: string;
  createdAt: string;
  confirmedAt: string | null;
  expiresAt: string | null;
  user: {
    id: number;
    firstName: string;
    lastName: string;
  };
}

const Payments: React.FC = () => {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    const fetchPayments = async () => {
      try {
        setIsLoading(true);
        const response = await axios.get('/api/payments', {
          params: { 
            page, 
            limit: 10,
            status: filter !== 'all' ? filter : undefined
          }
        });
        setPayments(response.data.payments);
        setTotalPages(response.data.totalPages);
        setError(null);
      } catch (err: any) {
        setError('Ошибка при загрузке платежей: ' + (err.response?.data?.message || err.message));
      } finally {
        setIsLoading(false);
      }
    };

    fetchPayments();
  }, [page, filter]);

  const handleFilterChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setFilter(e.target.value);
    setPage(1); // Сбрасываем на первую страницу при изменении фильтра
  };

  // Функция для форматирования дат
  const formatDate = (dateString: string | null) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString();
  };

  // Функция для форматирования статуса платежа
  const renderStatus = (status: string) => {
    let statusClass = '';
    switch (status) {
      case 'PENDING':
        statusClass = 'pending';
        break;
      case 'CONFIRMED':
        statusClass = 'confirmed';
        break;
      case 'CANCELLED':
        statusClass = 'cancelled';
        break;
      default:
        statusClass = '';
    }
    
    return (
      <span className={`status-badge ${statusClass}`}>
        {status}
      </span>
    );
  };

  // Рендер пагинации
  const renderPagination = () => {
    const pages = [];
    for (let i = 1; i <= totalPages; i++) {
      pages.push(
        <button
          key={i}
          onClick={() => setPage(i)}
          className={page === i ? 'active' : ''}
        >
          {i}
        </button>
      );
    }
    
    return (
      <div className="pagination">
        <button 
          onClick={() => setPage(prev => Math.max(prev - 1, 1))} 
          disabled={page === 1}
        >
          &laquo;
        </button>
        {pages}
        <button 
          onClick={() => setPage(prev => Math.min(prev + 1, totalPages))} 
          disabled={page === totalPages}
        >
          &raquo;
        </button>
      </div>
    );
  };

  if (isLoading && payments.length === 0) {
    return <div className="loading">Загрузка платежей...</div>;
  }

  return (
    <div className="payments-page">
      <h1 className="page-title">Платежи</h1>
      
      {error && <div className="error-message">{error}</div>}
      
      <div className="filters">
        <div className="filter-group">
          <label>Статус:</label>
          <select value={filter} onChange={handleFilterChange}>
            <option value="all">Все</option>
            <option value="PENDING">Ожидающие</option>
            <option value="CONFIRMED">Подтвержденные</option>
            <option value="CANCELLED">Отмененные</option>
          </select>
        </div>
      </div>
      
      <div className="table-container">
        <table className="payments-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Пользователь</th>
              <th>Сумма</th>
              <th>Статус</th>
              <th>Дата создания</th>
              <th>Дата оплаты</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {payments.map(payment => (
              <tr key={payment.id}>
                <td>{payment.id}</td>
                <td>
                  <Link to={`/users/${payment.userId}`}>
                    {payment.user.firstName} {payment.user.lastName}
                  </Link>
                </td>
                <td>{payment.amount} ₽</td>
                <td>{renderStatus(payment.status)}</td>
                <td>{formatDate(payment.createdAt)}</td>
                <td>{formatDate(payment.confirmedAt)}</td>
                <td>
                  <button className="btn btn-primary btn-sm">
                    Подробнее
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      
      {payments.length === 0 && (
        <div className="no-data">Платежи не найдены</div>
      )}
      
      {renderPagination()}
    </div>
  );
};

export default Payments; 