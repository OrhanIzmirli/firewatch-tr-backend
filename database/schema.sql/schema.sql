-- Create fires table
CREATE TABLE IF NOT EXISTS fires (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  location VARCHAR(255) NOT NULL,
  city VARCHAR(100) NOT NULL,
  district VARCHAR(100),
  description TEXT,
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'Aktif',
  risk_level INT DEFAULT 0,
  severity VARCHAR(50),
  source_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create news table
CREATE TABLE IF NOT EXISTS news (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  summary TEXT,
  body TEXT NOT NULL,
  source VARCHAR(100),
  source_url VARCHAR(500),
  category VARCHAR(50),
  is_breaking BOOLEAN DEFAULT FALSE,
  published_at TIMESTAMP,
  read_minutes INT,
  related_region VARCHAR(100),
  highlights TEXT,
  paragraphs TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create FCM tokens table
CREATE TABLE IF NOT EXISTS fcm_tokens (
  id SERIAL PRIMARY KEY,
  token VARCHAR(500) NOT NULL UNIQUE,
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  device_info VARCHAR(255),
  is_active BOOLEAN DEFAULT TRUE,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  fire_id INT REFERENCES fires(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  sent_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create risk_data table
CREATE TABLE IF NOT EXISTS risk_data (
  id SERIAL PRIMARY KEY,
  region VARCHAR(100) NOT NULL,
  date DATE NOT NULL,
  general_risk_score INT,
  risk_level VARCHAR(50),
  temperature DECIMAL(5, 2),
  humidity DECIMAL(5, 2),
  wind_speed DECIMAL(5, 2),
  wind_direction VARCHAR(50),
  dryness_index DECIMAL(5, 2),
  vegetation_density DECIMAL(5, 2),
  accessibility VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create fire_reports table (user-submitted fire reports)
CREATE TABLE IF NOT EXISTS fire_reports (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255),
  description TEXT,
  latitude DECIMAL(10, 8) NOT NULL,
  longitude DECIMAL(11, 8) NOT NULL,
  reporter_name VARCHAR(255),
  reporter_phone VARCHAR(50),
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  verified BOOLEAN DEFAULT FALSE,
  photo_urls TEXT[] DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX idx_fires_city ON fires(city);
CREATE INDEX idx_fires_status ON fires(status);
CREATE INDEX idx_news_category ON news(category);
CREATE INDEX idx_risk_data_region ON risk_data(region);