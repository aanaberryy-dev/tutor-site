const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const bcrypt = require('bcryptjs');
const path = require('path');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

const app = express();
const PORT = 3000;

// Настройка базы данных
const db = new sqlite3.Database('./database.db');

// Создание таблиц
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT,
    role TEXT,
    name TEXT,
    avatar TEXT DEFAULT 'default.png'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER,
    student_id INTEGER,
    date_time TEXT,
    status TEXT DEFAULT 'planned',
    price INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS homeworks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER,
    student_id INTEGER,
    title TEXT,
    description TEXT,
    deadline TEXT,
    status TEXT DEFAULT 'assigned',
    file TEXT,
    grade TEXT,
    feedback TEXT,
    student_done INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER,
    student_id INTEGER,
    amount INTEGER,
    date TEXT,
    type TEXT DEFAULT 'income'
  )`);
});

// Создаём папку для загрузок, если её нет
const fs = require('fs');
const uploadDir = './public/uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Настройка загрузки файлов
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// Настройки
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'tutor-secret-key-2024',
  resave: false,
  saveUninitialized: false
}));

// Middleware для проверки входа
function checkAuth(req, res, next) {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/login');
  }
}

// Главная страница
app.get('/', (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === 'teacher') {
      res.redirect('/teacher/dashboard');
    } else {
      res.redirect('/student/dashboard');
    }
  } else {
    res.redirect('/login');
  }
});

// Вход
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (user && bcrypt.compareSync(password, user.password)) {
      req.session.user = user;
      if (user.role === 'teacher') {
        res.redirect('/teacher/dashboard');
      } else {
        res.redirect('/student/dashboard');
      }
    } else {
      res.render('login', { error: 'Неверный логин или пароль' });
    }
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ========== КАБИНЕТ УЧИТЕЛЯ ==========

// Главная страница учителя
app.get('/teacher/dashboard', checkAuth, (req, res) => {
  if (req.session.user.role !== 'teacher') return res.redirect('/');
  
  db.all('SELECT * FROM lessons WHERE teacher_id = ? AND date(date_time) = date("now") ORDER BY date_time', 
    [req.session.user.id], (err, todayLessons) => {
    db.all('SELECT SUM(amount) as total FROM payments WHERE teacher_id = ? AND strftime("%Y-%m", date) = strftime("%Y-%m", "now")',
      [req.session.user.id], (err, moneyData) => {
      db.all('SELECT * FROM homeworks WHERE teacher_id = ? AND status = "submitted"',
        [req.session.user.id], (err, pendingHomeworks) => {
        res.render('teacher/dashboard', {
          user: req.session.user,
          todayLessons: todayLessons || [],
          totalMoney: moneyData[0]?.total || 0,
          pendingCount: pendingHomeworks?.length || 0
        });
      });
    });
  });
});

// Расписание
app.get('/teacher/calendar', checkAuth, (req, res) => {
  db.all(`SELECT lessons.*, users.name as student_name 
    FROM lessons JOIN users ON lessons.student_id = users.id 
    WHERE lessons.teacher_id = ? ORDER BY date_time`,
    [req.session.user.id], (err, lessons) => {
    db.all('SELECT id, name FROM users WHERE role = "student"', (err, students) => {
      res.render('teacher/calendar', { user: req.session.user, lessons, students });
    });
  });
});

app.post('/teacher/add-lesson', checkAuth, upload.none(), (req, res) => {
  const { student_id, date_time, price } = req.body;
  db.run('INSERT INTO lessons (teacher_id, student_id, date_time, price) VALUES (?, ?, ?, ?)',
    [req.session.user.id, student_id, date_time, price], (err) => {
    res.redirect('/teacher/calendar');
  });
});

app.get('/teacher/lesson-status/:id/:status', checkAuth, (req, res) => {
  db.run('UPDATE lessons SET status = ? WHERE id = ? AND teacher_id = ?',
    [req.params.status, req.params.id, req.session.user.id], (err) => {
    res.redirect('/teacher/calendar');
  });
});

// Список учеников
app.get('/teacher/students', checkAuth, (req, res) => {
  db.all('SELECT * FROM users WHERE role = "student"', (err, students) => {
    res.render('teacher/students', { user: req.session.user, students });
  });
});

// Карточка ученика
app.get('/teacher/student/:id', checkAuth, (req, res) => {
  db.get('SELECT * FROM users WHERE id = ?', [req.params.id], (err, student) => {
    if (!student) return res.redirect('/teacher/students');
    db.all('SELECT * FROM lessons WHERE student_id = ? AND teacher_id = ? ORDER BY date_time DESC LIMIT 20',
      [req.params.id, req.session.user.id], (err, lessons) => {
      db.all('SELECT * FROM homeworks WHERE student_id = ? AND teacher_id = ? ORDER BY deadline DESC',
        [req.params.id, req.session.user.id], (err, homeworks) => {
        db.all('SELECT * FROM payments WHERE student_id = ? AND teacher_id = ? ORDER BY date DESC',
          [req.params.id, req.session.user.id], (err, payments) => {
          res.render('teacher/student-detail', {
            user: req.session.user,
            student,
            lessons,
            homeworks,
            payments
          });
        });
      });
    });
  });
});

// Выдать домашнее задание
app.post('/teacher/add-homework', checkAuth, upload.single('file'), (req, res) => {
  const { student_id, title, description, deadline } = req.body;
  const file = req.file ? req.file.filename : null;
  db.run('INSERT INTO homeworks (teacher_id, student_id, title, description, deadline, file) VALUES (?, ?, ?, ?, ?, ?)',
    [req.session.user.id, student_id, title, description, deadline, file], (err) => {
    res.redirect('/teacher/student/' + student_id);
  });
});

// Добавить оплату
app.post('/teacher/add-payment', checkAuth, upload.none(), (req, res) => {
  const { student_id, amount, date } = req.body;
  db.run('INSERT INTO payments (teacher_id, student_id, amount, date) VALUES (?, ?, ?, ?)',
    [req.session.user.id, student_id, amount, date], (err) => {
    res.redirect('/teacher/student/' + student_id);
  });
});

// Домашки на проверку
app.get('/teacher/check-homeworks', checkAuth, (req, res) => {
  db.all(`SELECT homeworks.*, users.name as student_name 
    FROM homeworks JOIN users ON homeworks.student_id = users.id 
    WHERE homeworks.teacher_id = ? AND homeworks.status = 'submitted'`,
    [req.session.user.id], (err, homeworks) => {
    res.render('teacher/check', { user: req.session.user, homeworks });
  });
});

// Страница проверки конкретной домашки
app.get('/teacher/review-homework/:id', checkAuth, (req, res) => {
  db.get(`SELECT homeworks.*, users.name as student_name 
    FROM homeworks JOIN users ON homeworks.student_id = users.id 
    WHERE homeworks.id = ?`, [req.params.id], (err, homework) => {
    res.render('teacher/review', { user: req.session.user, homework });
  });
});

// Отправить оценку
app.post('/teacher/submit-review', checkAuth, upload.none(), (req, res) => {
  const { homework_id, grade, feedback } = req.body;
  db.run('UPDATE homeworks SET status = "checked", grade = ?, feedback = ? WHERE id = ?',
    [grade, feedback, homework_id], (err) => {
    res.redirect('/teacher/check-homeworks');
  });
});

// Финансы
app.get('/teacher/finances', checkAuth, (req, res) => {
  db.all(`SELECT strftime('%Y-%m', date) as month, SUM(amount) as total 
    FROM payments WHERE teacher_id = ? 
    GROUP BY month ORDER BY month DESC LIMIT 12`,
    [req.session.user.id], (err, monthlyData) => {
    db.all(`SELECT payments.*, users.name as student_name 
      FROM payments JOIN users ON payments.student_id = users.id 
      WHERE payments.teacher_id = ? ORDER BY date DESC LIMIT 50`,
      [req.session.user.id], (err, payments) => {
      res.render('teacher/finances', { 
        user: req.session.user, 
        monthlyData: monthlyData || [], 
        payments: payments || [] 
      });
    });
  });
});

// ========== КАБИНЕТ УЧЕНИКА ==========

// Главная ученика
app.get('/student/dashboard', checkAuth, (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/');
  db.all('SELECT * FROM homeworks WHERE student_id = ? ORDER BY deadline DESC',
    [req.session.user.id], (err, homeworks) => {
    res.render('student/dashboard', { 
      user: req.session.user, 
      homeworks: homeworks || [] 
    });
  });
});

// Галочка "Сделано"
app.post('/student/toggle-done', checkAuth, upload.none(), (req, res) => {
  const { homework_id, done } = req.body;
  db.run('UPDATE homeworks SET student_done = ? WHERE id = ? AND student_id = ?',
    [done, homework_id, req.session.user.id], (err) => {
    res.redirect('/student/dashboard');
  });
});

// Отправить домашку на проверку
app.post('/student/submit-homework', checkAuth, upload.single('file'), (req, res) => {
  const { homework_id } = req.body;
  const file = req.file ? req.file.filename : null;
  if (file) {
    db.run('UPDATE homeworks SET file = ?, status = "submitted" WHERE id = ? AND student_id = ?',
      [file, homework_id, req.session.user.id], (err) => {
      res.redirect('/student/dashboard');
    });
  } else {
    db.run('UPDATE homeworks SET status = "submitted" WHERE id = ? AND student_id = ?',
      [homework_id, req.session.user.id], (err) => {
      res.redirect('/student/dashboard');
    });
  }
});

// Задать вопрос
app.post('/student/ask-question', checkAuth, upload.none(), (req, res) => {
  const { homework_id, question } = req.body;
  db.run('UPDATE homeworks SET feedback = ? WHERE id = ? AND student_id = ?',
    ['Вопрос ученика: ' + question, homework_id, req.session.user.id], (err) => {
    res.redirect('/student/dashboard');
  });
});

// Профиль ученика
app.get('/student/profile', checkAuth, (req, res) => {
  res.render('student/profile', { user: req.session.user, success: null });
});

app.post('/student/update-avatar', checkAuth, upload.single('avatar'), (req, res) => {
  const avatar = req.file ? req.file.filename : 'default.png';
  db.run('UPDATE users SET avatar = ? WHERE id = ?', [avatar, req.session.user.id], (err) => {
    req.session.user.avatar = avatar;
    res.render('student/profile', { user: req.session.user, success: 'Аватар обновлён!' });
  });
});

// Запуск сервера
app.listen(PORT, () => {
  console.log('Сайт запущен: http://localhost:' + PORT);
  
  // Создать тестового учителя, если нет
  db.get("SELECT * FROM users WHERE role = 'teacher'", (err, teacher) => {
    if (!teacher) {
      const hash = bcrypt.hashSync('12345', 10);
      db.run("INSERT INTO users (email, password, role, name) VALUES (?, ?, ?, ?)",
        ['teacher@mail.com', hash, 'teacher', 'Репетитор']);
      console.log('Создан учитель: teacher@mail.com / 12345');
    }
  });

  // Создать тестового ученика, если нет
  db.get("SELECT * FROM users WHERE role = 'student'", (err, student) => {
    if (!student) {
      const hash = bcrypt.hashSync('12345', 10);
      db.run("INSERT INTO users (email, password, role, name) VALUES (?, ?, ?, ?)",
        ['student@mail.com', hash, 'student', 'Ученик Петя']);
      console.log('Создан ученик: student@mail.com / 12345');
    }
  });

  // Напоминания о занятиях (проверка каждый час)
  cron.schedule('0 * * * *', () => {
    console.log('Проверка напоминаний о занятиях...');
    const now = new Date();
    const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
    const timeStr = inOneHour.toISOString().slice(0, 16).replace('T', ' ');
    
    db.all(`SELECT lessons.*, users.email, users.name 
      FROM lessons JOIN users ON lessons.student_id = users.id 
      WHERE lessons.date_time LIKE ? AND lessons.status = 'planned'`,
      [timeStr + '%'], (err, lessons) => {
      if (lessons && lessons.length > 0) {
        console.log('Найдено занятий для напоминания: ' + lessons.length);
        // Здесь будет отправка email (настроим позже)
      }
    });
  });

  console.log('Система напоминаний запущена');
});